import { Injectable, effect, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import {
	API_BASE_URL,
	QUEUE_FALLBACK_MS,
	WS_URL,
	WS_TOPIC,
} from './api.config';
import {
	ExitMode,
	ExitRecord,
	QueueItem,
	Student,
	VanCall,
	VanDriver,
} from '../models/models';

export type Theme = 'dark' | 'light';

interface AlunoApi {
	id: number;
	nome: string;
	email?: string | null;
	matricula: string;
	fotoUrl?: string | null;
	ativo: boolean;
	cpf?: string | null;
	dataNascimento?: string | null;
}

interface CartaoApi {
	id: number;
	uid: string;
	tipo: 'ALUNO' | 'RESPONSAVEL';
	ativo: boolean;
	alunoId?: number | null;
	responsavelId?: number | null;
}

interface ChamadaApi {
	id: number;
	alunoId: number;
	nomeExibicao: string;
	fotoUrl?: string | null;
	status: string;
	origem: string;
	criadoEm: string;
}

interface LeituraApi {
	confirmacaoNecessaria: boolean;
	alunos: Array<{ alunoId: number; nome: string; fotoUrl?: string | null }>;
	chamada: ChamadaApi | null;
}

const STATE_KEY = 'portaria-state-v1';
const THEME_KEY = 'portaria-theme';
const STUDENT_META_KEY = 'portaria-student-meta-v1';
const VAN_DRIVERS_KEY = 'portaria-van-drivers-v1';

// Frames STOMP. As quebras de linha são REAIS (\n), não literais: sem isso o
// Spring nunca valida o frame e o WebSocket fica mudo (sem eventos na TV).
const STOMP_CONNECT =
	'CONNECT\naccept-version:1.2,1.1,1.0\nheart-beat:10000,10000\n\n';
const STOMP_SUBSCRIBE = 'SUBSCRIBE\nid:portaria-patio-0\ndestination:';
const STOMP_SUBSCRIBE_END = '\nack:auto\n\n';

const DEFAULT_VAN_DRIVERS: VanDriver[] = [
	{ id: 'VAN001', name: 'Marcos Almeida', plate: 'ABC-1D23', color: '#C8102E' },
	{ id: 'VAN002', name: 'Patrícia Ramos', plate: 'DEF-4G56', color: '#1769AA' },
];
type StudentMeta = {
	grade?: string;
	class?: string;
	parentName?: string;
	parentRelation?: string;
	guardianPhone?: string;
	email?: string;
	cpf?: string;
	birthDate?: string;
	isVan?: boolean;
	vanDriverId?: string;
	avatarColor?: string;
	photo?: string;
};

@Injectable({ providedIn: 'root' })
export class PortariaService {
	readonly students = signal<Student[]>([]);
	readonly studentsLoading = signal(false);
	readonly apiError = signal('');
	readonly queue = signal<QueueItem[]>([]);
	readonly exits = signal<ExitRecord[]>([]);
	readonly vanDrivers = signal<VanDriver[]>(this.readVanDrivers());
	readonly vanCall = signal<VanCall | null>(null);
	readonly theme = signal<Theme>(this.readTheme());

	private queueRefreshTimer?: ReturnType<typeof setTimeout>;
	private queueDebounceTimer?: ReturnType<typeof setTimeout>;
	/** A TV apenas exibe: não precisa de verificação periódica da fila. */
	private readonly isTv =
		typeof location !== 'undefined' &&
		location.hash.toLowerCase().startsWith('#tv');
	/**
	 * A fila é consultada por demanda: ao iniciar, no evento do WebSocket e, se o
	 * WebSocket estiver fora, por uma verificação de segurança a cada 5 s.
	 * Esse intervalo garante que a TV/lista atualize mesmo sem STOMP funcionando.
	 */
	private queueLoadInFlight = false;
	private studentsRetryTimer?: ReturnType<typeof setTimeout>;
	private studentsLoaded = false;
	private ws?: WebSocket;
	private wsHeartbeatTimer?: ReturnType<typeof setInterval>;
	private wsReconnectTimer?: ReturnType<typeof setTimeout>;
	private wsRetryDelay = 2000;
	readonly websocketConnected = signal(false);
	readonly wsUrl = WS_URL;

	constructor(private readonly http: HttpClient) {
		this.loadState();
		void this.loadStudents();
		void this.loadQueue();
		this.scheduleFallbackRefresh();
		this.connectWebSocket();

		effect(() =>
			document.documentElement.setAttribute('data-theme', this.theme()),
		);

		window.addEventListener('storage', (event) => {
			if (event.key === THEME_KEY) this.theme.set(this.readTheme());
			else if (event.key === STATE_KEY || event.key === null) {
				if (event.key === null) this.theme.set(this.readTheme());
				this.loadState();
			}
		});
	}

	private connectWebSocket(): void {
		if (typeof WebSocket === 'undefined') return;
		try {
			const socket = new WebSocket(WS_URL);
			this.ws = socket;

			socket.onopen = () => {
				this.wsRetryDelay = 2000;
				// Frames STOMP precisam de \n REAL (NULL como terminador).
				socket.send(`${STOMP_CONNECT}\u0000`);
			};

			socket.onmessage = (event: MessageEvent<string>) => {
				for (const rawFrame of String(event.data).split('\u0000')) {
					const frame = rawFrame.replace(/^\n+/, '');
					if (!frame.trim()) continue;
					const separator = frame.indexOf('\n\n');
					const headerText = separator >= 0 ? frame.slice(0, separator) : frame;
					const body = separator >= 0 ? frame.slice(separator + 2) : '';
					const command = headerText.split('\n', 1)[0];

					if (command === 'CONNECTED') {
						socket.send(
							`${STOMP_SUBSCRIBE}${WS_TOPIC}${STOMP_SUBSCRIBE_END}\u0000`,
						);
						this.websocketConnected.set(true);
						this.startHeartbeat(socket);
						// Ao (re)conectar, reconcilia a fila: eventos perdidos enquanto
						// o socket estava fora são recuperados aqui.
						this.refreshQueueSoon(0);
					} else if (command === 'MESSAGE') {
						this.onQueueChanged(body);
					} else if (command === 'ERROR') {
						console.error('Erro recebido do WebSocket STOMP:', body);
					}
				}
			};

			socket.onerror = () => {
				this.websocketConnected.set(false);
			};

			socket.onclose = () => {
				this.websocketConnected.set(false);
				this.stopHeartbeat();
				if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
				this.wsReconnectTimer = setTimeout(
					() => this.connectWebSocket(),
					this.wsRetryDelay,
				);
				this.wsRetryDelay = Math.min(this.wsRetryDelay * 2, 30000);
			};
		} catch (error) {
			this.websocketConnected.set(false);
			console.error('Não foi possível iniciar o WebSocket da portaria.', error);
		}
	}

	private startHeartbeat(socket: WebSocket): void {
		this.stopHeartbeat();
		this.wsHeartbeatTimer = setInterval(() => {
			if (socket.readyState === WebSocket.OPEN) socket.send('\n');
		}, 10000);
	}

	private stopHeartbeat(): void {
		if (this.wsHeartbeatTimer) clearInterval(this.wsHeartbeatTimer);
		this.wsHeartbeatTimer = undefined;
	}

	toggleTheme(): void {
		const next: Theme = this.theme() === 'dark' ? 'light' : 'dark';
		this.theme.set(next);
		try {
			localStorage.setItem(THEME_KEY, next);
		} catch {
			/* armazenamento opcional */
		}
	}

	private readTheme(): Theme {
		try {
			return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
		} catch {
			return 'dark';
		}
	}

	/**
	 * Resolve a URL da foto vinda do back-end para uma URL absoluta usável no <img>.
	 * Aceita URL completa (http/https), caminho relativo a partir da raiz da API
	 * (ex.: /uploads/xxx.jpg) ou apenas o nome do arquivo (ex.: abc123.jpg).
	 */
	resolveFotoUrl(fotoUrl?: string | null): string | undefined {
		if (!fotoUrl) return undefined;
		const value = fotoUrl.trim();
		if (!value) return undefined;
		if (/^https?:\/\//i.test(value)) return value;
		const origin = new URL(API_BASE_URL, location.origin).origin;
		if (value.startsWith('/')) return `${origin}${value}`;
		// Nome de arquivo puro: assume a pasta de uploads exposta pelo back-end.
		return `${origin}/uploads/${value}`;
	}

	private studentFromApi(aluno: AlunoApi, cards: CartaoApi[]): Student {
		const card = cards.find(
			(c) =>
				c.ativo && c.tipo === 'ALUNO' && Number(c.alunoId) === Number(aluno.id),
		);
		const name = aluno.nome || 'Aluno sem nome';
		const meta = this.readStudentMeta()[String(aluno.id)] ?? {};
		return {
			id: String(aluno.id),
			name,
			// O DTO atual do back-end ainda não devolve a turma do aluno.
			grade: meta.grade || 'Não informado',
			class: meta.class || '—',
			parentName: meta.parentName || 'Não informado',
			parentRelation: meta.parentRelation || 'Responsável',
			rfidCard: card?.uid ?? '',
			isVan: !!meta.isVan,
			vanDriverId: meta.isVan ? meta.vanDriverId : undefined,
			avatarColor: meta.avatarColor || '#C8102E',
			avatarInitials: name
				.split(' ')
				.filter(Boolean)
				.slice(0, 2)
				.map((p) => p[0])
				.join('')
				.toUpperCase(),
			// A foto vem do back-end (fotoUrl); o localStorage é apenas fallback.
			photo: this.resolveFotoUrl(aluno.fotoUrl) || meta.photo,
			email: aluno.email || meta.email || '',
			cpf: aluno.cpf || meta.cpf || '',
			birthDate: aluno.dataNascimento || meta.birthDate || '',
			guardianPhone: meta.guardianPhone || '',
		};
	}

	async loadStudents(): Promise<void> {
		this.studentsLoading.set(true);
		this.apiError.set('');
		try {
			const [alunos, cartoes] = await Promise.all([
				firstValueFrom(
					this.http
						.get<AlunoApi[]>(`${API_BASE_URL}/alunos`)
						.pipe(timeout(10000)),
				),
				firstValueFrom(
					this.http
						.get<CartaoApi[]>(`${API_BASE_URL}/cartoes`)
						.pipe(timeout(10000)),
				).catch(() => [] as CartaoApi[]),
			]);
			// O Spring pode devolver { content: [...] } (Page) em vez de um array.
			const lista: AlunoApi[] = Array.isArray(alunos)
				? alunos
				: Array.isArray((alunos as any)?.content)
					? ((alunos as any).content as AlunoApi[])
					: [];
			this.students.set(
				lista.map((aluno: AlunoApi) => this.studentFromApi(aluno, cartoes)),
			);
			this.studentsLoaded = true;
			this.apiError.set('');
		} catch (error: any) {
			const status = error?.status ?? 0;
			this.apiError.set(
				status === 0
					? `Sem conexão com a API em ${API_BASE_URL}. Verifique se o Spring Boot está ligado, se aceita conexões da rede (server.address=0.0.0.0) e se o firewall libera a porta.`
					: `A API respondeu ${status} em ${API_BASE_URL}/alunos. Confira se o CORS permite a origem ${location.origin}.`,
			);
			console.error('Falha ao carregar alunos da API', error);
			this.scheduleStudentsRetry();
		} finally {
			this.studentsLoading.set(false);
		}
	}

	/** Se a primeira carga falhar (back-end ainda subindo), tenta de novo. */
	private scheduleStudentsRetry(): void {
		if (this.studentsRetryTimer) clearTimeout(this.studentsRetryTimer);
		this.studentsRetryTimer = setTimeout(() => {
			this.studentsRetryTimer = undefined;
			void this.loadStudents();
		}, 5000);
	}

	private readStudentMeta(): Record<string, StudentMeta> {
		try {
			return JSON.parse(localStorage.getItem(STUDENT_META_KEY) ?? '{}');
		} catch {
			return {};
		}
	}

	private saveStudentMeta(id: string, data: StudentMeta): void {
		const all = this.readStudentMeta();
		all[id] = { ...(all[id] ?? {}), ...data };
		try {
			localStorage.setItem(STUDENT_META_KEY, JSON.stringify(all));
		} catch {
			/* armazenamento opcional */
		}
	}

	async addStudent(data: Omit<Student, 'id'>): Promise<Student> {
		// Fluxo atualizado: primeiro cadastra o aluno (sem foto) e depois envia a foto
		// separadamente via POST /api/alunos/{id}/foto (multipart/form-data).
		const payload = {
			nome: data.name.trim(),
			email: data.email?.trim() || null,
			cpf: data.cpf?.trim() || null,
			dataNascimento: data.birthDate || null,
			matricula: `ALU${Date.now()}`,
			ativo: true,
		};
		const created = await firstValueFrom(
			this.http.post<AlunoApi>(`${API_BASE_URL}/alunos`, payload),
		);
		this.saveStudentMeta(String(created.id), {
			grade: data.grade,
			class: data.class,
			parentName: data.parentName,
			parentRelation: data.parentRelation,
			guardianPhone: data.guardianPhone,
			email: data.email,
			cpf: data.cpf,
			birthDate: data.birthDate,
			isVan: data.isVan,
			vanDriverId: data.isVan ? data.vanDriverId : undefined,
			avatarColor: data.avatarColor,
			photo: data.photo,
		});
		if (data.photo?.startsWith('data:image/')) {
			await this.uploadFoto(String(created.id), data.photo);
		} else if (data.photo) {
			// Foto em URL externa (http/https): salva apenas a URL, sem upload multipart.
			this.saveStudentMeta(String(created.id), { photo: data.photo });
		}
		if (data.rfidCard?.trim()) {
			await firstValueFrom(
				this.http.post<CartaoApi>(`${API_BASE_URL}/cartoes`, {
					uid: data.rfidCard.trim().toUpperCase().replace(/\s+/g, ''),
					tipo: 'ALUNO',
					ativo: true,
					alunoId: created.id,
				}),
			);
		}
		await this.loadStudents();
		const saved = this.students().find(
			(student) => student.id === String(created.id),
		);
		if (!saved)
			throw new Error(
				'O aluno foi criado, mas não apareceu na listagem após atualizar.',
			);
		return saved;
	}

	/** Converte um data URL para File e envia via multipart para POST /alunos/{id}/foto. */
	private async uploadFoto(alunoId: string, dataUrl: string): Promise<void> {
		try {
			const file = this.dataUrlToFile(dataUrl, `aluno-${alunoId}.jpg`);
			const form = new FormData();
			form.append('foto', file);
			const updated = await firstValueFrom(
				this.http.post<AlunoApi>(
					`${API_BASE_URL}/alunos/${encodeURIComponent(alunoId)}/foto`,
					form,
				),
			);
			// Persiste a fotoUrl devolvida pelo back-end como fonte da verdade.
			if (updated?.fotoUrl) {
				this.saveStudentMeta(alunoId, {
					photo: this.resolveFotoUrl(updated.fotoUrl),
				});
			}
		} catch (error) {
			// O cadastro do aluno permanece válido mesmo se o upload da foto falhar.
			console.error('Falha ao enviar foto do aluno', error);
		}
	}

	private dataUrlToFile(dataUrl: string, filename: string): File {
		const [meta, base64] = dataUrl.split(',');
		const mime = meta.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
		const bin = atob(base64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return new File([bytes], filename, { type: mime });
	}

	async deleteStudent(id: string): Promise<void> {
		await firstValueFrom(
			this.http.delete(`${API_BASE_URL}/alunos/${encodeURIComponent(id)}`),
		);
		const all = this.readStudentMeta();
		delete all[id];
		try {
			localStorage.setItem(STUDENT_META_KEY, JSON.stringify(all));
		} catch {
			/* armazenamento opcional */
		}
		await this.loadStudents();
	}

	async updateStudent(student: Student): Promise<void> {
		const payload = {
			nome: student.name.trim(),
			email: student.email?.trim() || null,
			cpf: student.cpf?.trim() || null,
			dataNascimento: student.birthDate || null,
			matricula: `ALU${student.id}`,
			ativo: true,
		};
		await firstValueFrom(
			this.http.put(
				`${API_BASE_URL}/alunos/${encodeURIComponent(student.id)}`,
				payload,
			),
		);
		this.saveStudentMeta(student.id, {
			grade: student.grade,
			class: student.class,
			parentName: student.parentName,
			parentRelation: student.parentRelation,
			guardianPhone: student.guardianPhone,
			email: student.email,
			cpf: student.cpf,
			birthDate: student.birthDate,
			isVan: student.isVan,
			vanDriverId: student.isVan ? student.vanDriverId : undefined,
			avatarColor: student.avatarColor,
			photo: student.photo,
		});
		// A foto agora é enviada separadamente via multipart, nunca pelo PUT de dados.
		if (student.photo?.startsWith('data:image/')) {
			await this.uploadFoto(student.id, student.photo);
		}
		await this.loadStudents();
	}

	async processRfidRead(
		uid: string,
		ponto: 'PORTARIA' | 'PORTAO' = 'PORTARIA',
	): Promise<LeituraApi> {
		// A leitura NÃO espera o refresh da fila: o fluxo de chamada responde na hora.
		// A fila é atualizada depois, em segundo plano, pelo gatilho do WebSocket.
		const result = await firstValueFrom(
			this.http.post<LeituraApi>(`${API_BASE_URL}/leituras`, { uid, ponto }),
		);
		if (result?.chamada) this.refreshQueueSoon();
		return result;
	}

	async confirmGuardianRead(uid: string, alunoId: number): Promise<void> {
		const call = await firstValueFrom(
			this.http.post<ChamadaApi>(`${API_BASE_URL}/leituras/confirmacao`, {
				uid,
				alunoId,
			}),
		);
		if (call) this.refreshQueueSoon();
	}

	/**
	 * Gatilho recebido pelo WebSocket. Só é chamado quando o back-end avisa que
	 * houve uma chamada confirmada — não existe mais consulta em intervalo curto.
	 * Vários eventos seguidos são agrupados numa única requisição.
	 */
	private onQueueChanged(body: string): void {
		// Chamada de van publicada por outro cliente (ex.: portaria de outro PC).
		const vanEvent = this.parseVanEvent(body);
		if (vanEvent) {
			this.vanCall.set({
				driver: vanEvent.driver,
				calledAt: new Date(vanEvent.calledAt),
			});
			// Mantém o estado local alinhado entre as janelas da mesma máquina.
			this.saveState();
			return;
		}
		if (!this.isConfirmationEvent(body)) {
			// Evento de outra natureza: ignora para não gerar tráfego inútil.
			console.debug('Evento WebSocket ignorado (não é confirmação):', body);
			return;
		}
		this.refreshQueueSoon();
	}

	/** Reconhece o JSON publicado em vanCall para o tópico. */
	private parseVanEvent(body: string): VanCall | null {
		if (!body?.trim()) return null;
		try {
			const data = JSON.parse(body);
			const driver = data?.vanCall?.driver ?? data?.driver;
			if (!driver?.id || !driver?.name) return null;
			return {
				driver: {
					id: String(driver.id),
					name: String(driver.name),
					plate: String(driver.plate ?? ''),
					color: String(driver.color ?? '#C8102E'),
					phone: driver.phone ? String(driver.phone) : undefined,
				},
				calledAt: new Date(
					data.vanCall?.calledAt ?? data.calledAt ?? Date.now(),
				),
			};
			// Estrutura aceita: { vanCall: { driver: {...}, calledAt } }
			// ou { driver: {...}, calledAt }.
		} catch {
			return null;
		}
	}

	private isConfirmationEvent(body: string): boolean {
		const text = (body || '').trim().toLowerCase();
		// Corpo vazio é o formato mais comum de notificação STOMP: aceita.
		if (!text) return true;
		// Payload com dados do aluno/chamada também é uma notificação válida.
		if (text.startsWith('{') || text.startsWith('[')) return true;
		return /confirm|saida|chamada|called|queue|fila|patio/.test(text);
	}

	/** Atualiza a fila em segundo plano, agrupando eventos próximos. */
	private refreshQueueSoon(delay = 300): void {
		if (this.queueDebounceTimer) clearTimeout(this.queueDebounceTimer);
		this.queueDebounceTimer = setTimeout(() => {
			this.queueDebounceTimer = undefined;
			void this.loadQueue();
		}, delay);
	}

	private scheduleFallbackRefresh(): void {
		// Rede de segurança se o WebSocket estiver fora (ex.: SockJS no back-end).
		// Também roda na TV: senão as chamadas nunca apareceriam sem STOMP.
		if (this.queueRefreshTimer) clearTimeout(this.queueRefreshTimer);
		this.queueRefreshTimer = setTimeout(() => {
			if (!this.websocketConnected()) this.refreshQueueSoon(0);
			this.scheduleFallbackRefresh();
		}, QUEUE_FALLBACK_MS);
	}

	async loadQueue(): Promise<void> {
		// Evita requisições concorrentes a /api/chamadas.
		if (this.queueLoadInFlight) return;
		this.queueLoadInFlight = true;
		try {
			const calls = await firstValueFrom(
				this.http
					.get<ChamadaApi[]>(`${API_BASE_URL}/chamadas`)
					// Se o back-end não responder, libera o fluxo em vez de travar a fila.
					.pipe(timeout(8000)),
			);
			if (!Array.isArray(calls)) return;
			const students = this.students();
			const queue = calls.map((call) => {
				const existing = students.find(
					(student) => student.id === String(call.alunoId),
				);
				const name = call.nomeExibicao || existing?.name || 'Aluno';
				const student: Student = existing ?? {
					id: String(call.alunoId),
					name,
					grade: 'Não informado',
					class: '—',
					parentName: 'Não informado',
					parentRelation: 'Responsável',
					rfidCard: '',
					isVan: false,
					avatarColor: '#C8102E',
					photo: this.resolveFotoUrl(call.fotoUrl) || undefined,
					avatarInitials: name
						.split(' ')
						.filter(Boolean)
						.slice(0, 2)
						.map((p) => p[0])
						.join('')
						.toUpperCase(),
				};
				return {
					id: String(call.id),
					student: {
						...student,
						name: call.nomeExibicao || student.name,
						photo: this.resolveFotoUrl(call.fotoUrl) || student.photo,
					},
					queuedAt: new Date(call.criadoEm),
				};
			});
			this.queue.set(queue);
		} catch (error) {
			// A falha da fila NÃO limpa nem sobrescreve o erro de alunos:
			// são fluxos independentes e a portaria precisa seguir funcionando.
			console.warn('Falha ao atualizar a fila de chamadas', error);
		} finally {
			this.queueLoadInFlight = false;
		}
	}

	async callManual(student: Student): Promise<void> {
		const call = await firstValueFrom(
			this.http.post<ChamadaApi>(`${API_BASE_URL}/chamadas/manual`, {
				alunoId: Number(student.id),
			}),
		);
		// Mostra o aluno na fila na hora e reconcilia em segundo plano.
		if (call) {
			const now = new Date();
			this.queue.update((items) => [
				{
					id: String(call.id ?? `LOCAL-${now.getTime()}`),
					student,
					queuedAt: call.criadoEm ? new Date(call.criadoEm) : now,
				},
				...items.filter((i) => i.student.id !== student.id),
			]);
		}
		this.refreshQueueSoon();
	}

	/**
	 * Confirma a saída do aluno registrando COMO ele saiu (van ou responsável).
	 * side = 'VAN': sai com o motorista da van vinculada ao aluno.
	 * side = 'RESPONSAVEL': sai com o responsável (ou outro adulto informado).
	 */
	async confirmExit(
		queueId: string,
		side: ExitMode = 'RESPONSAVEL',
		releasedToName?: string,
	): Promise<void> {
		const item = this.queue().find((x) => x.id === queueId);
		await firstValueFrom(
			this.http.post<ChamadaApi>(
				`${API_BASE_URL}/chamadas/${encodeURIComponent(queueId)}/saida`,
				{ formaSaida: side },
			),
		);
		// Remove da fila imediatamente, sem esperar o GET /api/chamadas.
		if (item) {
			this.queue.update((items) => items.filter((x) => x.id !== queueId));
			const driver = this.vanDrivers().find(
				(d) => d.id === item.student.vanDriverId,
			);
			const releasedTo =
				side === 'VAN'
					? driver?.name
						? `Van — ${driver.name}`
						: 'Van escolar'
					: releasedToName?.trim() || item.student.parentName || 'Responsável';
			this.exits.update((items) => [
				{
					id: `EX-${Date.now()}`,
					student: item.student,
					exitAt: new Date(),
					mode: side,
					releasedTo,
				},
				...items,
			]);
		}
		this.saveState();
		// Reconcilia em segundo plano para refletir o estado real do back-end.
		this.refreshQueueSoon();
	}

	// ---------------------------------------------------------------------
	// Cadastro de vans / motoristas (mantido no navegador, pois o back-end
	// atual ainda não possui endpoint para motoristas).
	// ---------------------------------------------------------------------
	private readVanDrivers(): VanDriver[] {
		try {
			const parsed = JSON.parse(
				localStorage.getItem(VAN_DRIVERS_KEY) ?? 'null',
			);
			if (Array.isArray(parsed) && parsed.length) return parsed;
		} catch {
			/* JSON inválido: usa os padrões */
		}
		return DEFAULT_VAN_DRIVERS.map((d) => ({ ...d }));
	}

	private persistVanDrivers(): void {
		try {
			localStorage.setItem(VAN_DRIVERS_KEY, JSON.stringify(this.vanDrivers()));
		} catch {
			/* armazenamento opcional */
		}
	}

	driverName(driverId?: string): string {
		if (!driverId) return '';
		return this.vanDrivers().find((d) => d.id === driverId)?.name ?? '';
	}

	addVanDriver(data: {
		name: string;
		plate: string;
		phone?: string;
		color?: string;
	}): VanDriver {
		const driver: VanDriver = {
			id: `VAN${String(Date.now()).slice(-6)}`,
			name: data.name.trim(),
			plate: data.plate.trim().toUpperCase(),
			phone: data.phone?.trim() || undefined,
			color: data.color || '#C8102E',
		};
		this.vanDrivers.update((list) => [...list, driver]);
		this.persistVanDrivers();
		return driver;
	}

	updateVanDriver(
		driverId: string,
		data: { name: string; plate: string; phone?: string; color?: string },
	): void {
		this.vanDrivers.update((list) =>
			list.map((driver) =>
				driver.id === driverId
					? {
							...driver,
							name: data.name.trim(),
							plate: data.plate.trim().toUpperCase(),
							phone: data.phone?.trim() || undefined,
							color: data.color || driver.color,
						}
					: driver,
			),
		);
		this.persistVanDrivers();
	}

	removeVanDriver(driverId: string): void {
		this.vanDrivers.update((list) =>
			list.filter((driver) => driver.id !== driverId),
		);
		this.persistVanDrivers();
		// Remove o vínculo dos alunos com o motorista excluído.
		const students = this.students().filter(
			(student) => student.vanDriverId === driverId,
		);
		this.students.update((list) =>
			list.map((student) =>
				student.vanDriverId === driverId
					? { ...student, vanDriverId: undefined }
					: student,
			),
		);
		for (const student of students) {
			this.saveStudentMeta(student.id, { vanDriverId: undefined });
		}
	}

	studentsByDriver(driverId: string): Student[] {
		// O vínculo aluno/motorista é mantido no navegador (STUDENT_META_KEY),
		// pois o back-end atual ainda não possui esse relacionamento.
		return this.students().filter(
			(student) => student.isVan && student.vanDriverId === driverId,
		);
	}

	callDriver(driver: VanDriver): void {
		const call: VanCall = { driver, calledAt: new Date() };
		this.vanCall.set(call);
		this.saveState();
		// Publica a chamada no tópico STOMP para que todos os clientes
		// (TV, inspetora, portaria) em outras máquinas sejam avisados.
		this.publishVanCall(call);
	}

	/**
	 * Envia o frame STOMP SEND com a chamada de van para o mesmo destino que o
	 * back-end usa. O SimpleBroker do Spring redistribui para todos os
	 * assinantes do tópico — incluindo esta própria janela.
	 */
	private publishVanCall(call: VanCall): void {
		const socket = this.ws;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			console.warn(
				'Chamada de van registrada localmente, mas WebSocket não está conectado — outros PCs não serão avisados.',
			);
			return;
		}
		const payload = JSON.stringify({
			vanCall: {
				driver: call.driver,
				calledAt: call.calledAt.toISOString(),
			},
		});
		const frame = `SEND\ndestination:${WS_TOPIC}\ncontent-type:application/json\n\n${payload}\u0000`;
		try {
			socket.send(frame);
		} catch (error) {
			console.error('Falha ao publicar chamada de van via STOMP:', error);
		}
	}

	endVanCall(): void {
		this.vanCall.set(null);
		this.saveState();
	}

	private saveState(): void {
		const call = this.vanCall();
		const data = {
			exits: this.exits().map((i) => ({
				id: i.id,
				student: i.student,
				exitAt: i.exitAt.toISOString(),
				mode: i.mode,
				releasedTo: i.releasedTo,
			})),
			vanCall: call
				? { driverId: call.driver.id, calledAt: call.calledAt.toISOString() }
				: null,
		};
		try {
			localStorage.setItem(STATE_KEY, JSON.stringify(data));
		} catch {
			/* armazenamento opcional */
		}
	}

	private loadState(): void {
		let data: any = null;
		try {
			data = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null');
		} catch {
			/* JSON inválido */
		}
		const today = new Date().toDateString();
		const exits: ExitRecord[] = (data?.exits ?? [])
			.filter(
				(i: any) => i.student && new Date(i.exitAt).toDateString() === today,
			)
			.map((i: any) => ({
				id: i.id,
				student: i.student,
				exitAt: new Date(i.exitAt),
				mode: (i.mode === 'VAN' ? 'VAN' : 'RESPONSAVEL') as ExitMode,
				releasedTo: i.releasedTo || i.student?.parentName || 'Responsável',
			}));
		const driver = this.vanDrivers().find(
			(d) => d.id === data?.vanCall?.driverId,
		);
		const vanCall: VanCall | null =
			driver && data?.vanCall
				? { driver, calledAt: new Date(data.vanCall.calledAt) }
				: null;
		this.exits.set(exits);
		this.vanCall.set(vanCall);
	}
}
