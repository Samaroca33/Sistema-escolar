import {
	ChangeDetectorRef,
	Component,
	HostListener,
	OnDestroy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PortariaService } from './core/portaria.service';
import { ExitMode, Student, VanDriver } from './models/models';
import { AvatarComponent } from './shared/avatar.component';
import { TvComponent } from './tv/tv.component';

type View =
	| 'portaria'
	| 'manual'
	| 'van'
	| 'inspetora'
	| 'tv'
	| 'relatorio'
	| 'cadastro';

interface NavItem {
	key: View;
	label: string;
	icon: string;
}

@Component({
	selector: 'app-root',
	standalone: true,
	imports: [CommonModule, FormsModule, AvatarComponent, TvComponent],
	templateUrl: './app.component.html',
})
export class AppComponent implements OnDestroy {
	cardId = '';
	view: View = 'portaria';

	/** A TV abre em outra janela, com o endereço terminado em #tv */
	readonly isTv = location.hash.toLowerCase().startsWith('#tv');

	readonly navItems: NavItem[] = [
		{ key: 'portaria', label: 'Portaria', icon: '📡' },
		{ key: 'manual', label: 'Chamada Manual', icon: '📝' },
		{ key: 'van', label: 'Van Escolar', icon: '🚐' },
		{ key: 'inspetora', label: 'Inspetora', icon: '✅' },
		{ key: 'tv', label: 'Televisão', icon: '📺' },
		{ key: 'relatorio', label: 'Relatório Diário', icon: '📊' },
		{ key: 'cadastro', label: 'Cadastrar Aluno', icon: '🎒' },
	];

	now = new Date();
	private readonly timer = setInterval(() => {
		this.now = new Date();
	}, 1000);

	scanning = false;
	detected: Student | null = null;
	confirmed: Student | null = null;
	demoOpen = false;
	flash = false;

	manualGrade = 'all';
	manualSearch = '';
	editingStudent: Student | null = null;
	editDraft: Partial<Student> = {};
	deletingStudentId: string | null = null;
	editError = '';
	editMessage = '';
	pending: Student | null = null;
	manualConfirmed: Student | null = null;

	reportGrade = 'all';

	/** Forma de saída escolhida na confirmação: van ou responsável. */
	exitSide: ExitMode = 'RESPONSAVEL';
	/** Nome de quem retirou o aluno (usado quando a saída é com responsável). */
	exitGuardianName = '';

	/** Cadastro/edição de motoristas de van. */
	vanForm: { name: string; plate: string; phone: string; color: string } = {
		name: '',
		plate: '',
		phone: '',
		color: '#C8102E',
	};
	vanFormOpen = false;
	editingVanId: string | null = null;
	vanError = '';
	vanMessage = '';

	cadastroDraft: Partial<Student> = this.newCadastroDraft();
	cadastroMsg = '';
	cadastroError = '';
	readerStatus = 'Leitor desconectado';
	readerConnected = false;
	unknownCard = '';
	guardianChoices: Array<{
		alunoId: number;
		nome: string;
		fotoUrl?: string | null;
	}> = [];
	pendingGuardianUid = '';
	apiActionError = '';
	private serialPort: any = null;
	private serialReader: any = null;
	private reading = false;
	/** True enquanto uma leitura de cartão está sendo enviada ao back-end. */
	private readInFlight = false;

	constructor(
		public svc: PortariaService,
		private cdr: ChangeDetectorRef,
	) {}

	ngOnDestroy(): void {
		clearInterval(this.timer);
		void this.disconnectReader();
	}

	/** Conecta ao ESP32 pela porta serial USB usando Web Serial (Chrome/Edge). */
	async connectReader(): Promise<void> {
		const serial = (navigator as any).serial;
		if (!serial) {
			this.readerStatus =
				'Este navegador não oferece Web Serial. Use Chrome ou Edge em localhost/HTTPS.';
			return;
		}
		try {
			this.serialPort = await serial.requestPort();
			await this.serialPort.open({ baudRate: 115200 });
			this.readerConnected = true;
			this.readerStatus = 'ESP32 conectado — aguardando UID';
			this.reading = true;
			const decoder = new TextDecoderStream();
			const pipePromise = this.serialPort.readable.pipeTo(decoder.writable);
			this.serialReader = decoder.readable.getReader();
			let buffer = '';
			while (this.reading && this.serialReader) {
				const { value, done } = await this.serialReader.read();
				if (done) break;
				buffer += value;
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					const uid = line.trim();
					if (uid && !/SISTEMA|RFID|LEITOR|INICIADO/i.test(uid)) {
						const cleanUid = uid.replace(/^UID\s*[:=]\s*/i, '').trim();
						if (cleanUid) {
							this.cardId = cleanUid;
							// Sem await: o loop continua lendo a serial imediatamente.
							// Sem isso, uma leitura lenta bloqueia o leitor e as
							// próximas passadas de cartão são perdidas.
							void this.handleScannedUid(cleanUid);
						}
					}
				}
			}
			await pipePromise.catch(() => undefined);
		} catch (error) {
			this.readerStatus =
				'Não foi possível conectar ao ESP32. Verifique o cabo e a porta selecionada.';
			this.readerConnected = false;
			console.error('Erro no leitor serial', error);
		}
	}

	async disconnectReader(): Promise<void> {
		this.reading = false;
		try {
			await this.serialReader?.cancel();
		} catch {
			/* leitor já encerrado */
		}
		try {
			this.serialReader?.releaseLock();
		} catch {
			/* lock já liberado */
		}
		try {
			await this.serialPort?.close();
		} catch {
			/* porta já fechada */
		}
		this.serialReader = null;
		this.serialPort = null;
		this.readerConnected = false;
		this.readerStatus = 'Leitor desconectado';
	}

	private async handleScannedUid(uid: string): Promise<void> {
		// Ignora reenvios do mesmo cartão enquanto um pedido está em andamento,
		// para não disparar duas chamadas para a mesma passada.
		if (this.readInFlight) return;
		this.readInFlight = true;
		this.cardId = uid;
		this.unknownCard = '';
		this.apiActionError = '';
		this.guardianChoices = [];
		try {
			const result = await this.svc.processRfidRead(uid, 'PORTARIA');
			if (result.confirmacaoNecessaria) {
				this.pendingGuardianUid = uid;
				this.guardianChoices = result.alunos ?? [];
				this.readerStatus =
					'Cartão de responsável reconhecido. Selecione o aluno.';
				return;
			}
			// A lista de alunos já está carregada em memória: nada de rebaixar
			// /alunos e /cartoes a cada cartão passado.
			const call = result.chamada;
			const student = call
				? this.svc.students().find((item) => item.id === String(call.alunoId))
				: undefined;
			this.confirmed = student ?? null;
			this.readerStatus = call
				? `Leitura processada para ${call.nomeExibicao}.`
				: 'Leitura processada pela API.';
			this.cardId = '';
			if (this.confirmed) setTimeout(() => (this.confirmed = null), 3500);
		} catch (error) {
			console.error('Falha ao processar UID na API', error);
			this.unknownCard = uid;
			this.readerStatus =
				'A API não reconheceu o cartão ou não foi possível conectar.';
			this.apiActionError =
				'A leitura não foi processada. Confirme se o cartão está cadastrado e vinculado no back-end e se a API está acessível.';
		} finally {
			this.readInFlight = false;
		}
	}

	async confirmGuardianStudent(choice: {
		alunoId: number;
		nome: string;
		fotoUrl?: string | null;
	}): Promise<void> {
		try {
			await this.svc.confirmGuardianRead(
				this.pendingGuardianUid,
				choice.alunoId,
			);
			await this.svc.loadStudents();
			this.confirmed =
				this.svc
					.students()
					.find((student) => student.id === String(choice.alunoId)) ?? null;
			this.guardianChoices = [];
			this.pendingGuardianUid = '';
			this.cardId = '';
			this.readerStatus = `Chamada registrada para ${choice.nome}.`;
			if (this.confirmed) setTimeout(() => (this.confirmed = null), 3500);
		} catch (error) {
			console.error('Falha ao confirmar aluno do responsável', error);
			this.apiActionError =
				'Não foi possível confirmar o aluno para este cartão de responsável.';
		}
	}

	reloadStudents(): void {
		// Reconsulta a API (útil quando o back-end sobe depois da página).
		void this.svc.loadStudents();
		void this.svc.loadQueue();
	}

	toggleTheme(): void {
		this.svc.toggleTheme();
	}

	@HostListener('document:keydown.escape')
	onEscape(): void {
		this.cardId = '';
		this.detected = null;
		this.demoOpen = false;
		this.guardianChoices = [];
		this.pendingGuardianUid = '';
	}

	openTv(): void {
		window.open(`${location.pathname}#tv`, 'portaria-tv');
	}

	nav(view: View): void {
		if (view === 'tv') {
			this.openTv();
			return;
		}
		this.view = view;
		this.cardId = '';
		this.pending = null;
		this.detected = null;
		this.demoOpen = false;
	}

	get pageTitle(): string {
		return this.navItems.find((x) => x.key === this.view)?.label ?? 'Portaria';
	}

	get pageSubtitle(): string {
		switch (this.view) {
			case 'portaria':
				return 'Leitor RFID — Saída de Alunos';
			case 'manual':
				return 'Seleção pela Inspetora';
			case 'van':
				return 'Gestão de motoristas e alunos';
			case 'inspetora':
				return 'Confirmação de Saída';
			case 'tv':
				return 'Painel de Chamada — abre em outra janela';
			case 'relatorio':
				return 'Histórico de saídas da sessão';
			case 'cadastro':
				return 'Cadastro de novos alunos';
		}
	}

	get queueCount(): number {
		return this.svc.queue().length;
	}

	get exitCount(): number {
		return this.svc.exits().length;
	}

	get manualHasFilter(): boolean {
		return true;
	}

	get manualStudents(): Student[] {
		if (!this.manualHasFilter) return [];
		const q = this.manualSearch.trim().toLowerCase();
		return this.svc.students().filter((student) => {
			const normalizedGrade =
				student.grade === '5º Ano' ? `5º Ano ${student.class}` : student.grade;
			const matchesGrade =
				this.manualGrade === 'all' ||
				normalizedGrade === this.manualGrade ||
				(this.manualGrade === '5º Ano A' &&
					student.grade === '5º Ano' &&
					student.class === 'A') ||
				(this.manualGrade === '5º Ano B' &&
					student.grade === '5º Ano' &&
					student.class === 'B');
			const matchesName = !q || student.name.toLowerCase().includes(q);
			return matchesGrade && matchesName;
		});
	}

	get reportByMode() {
		const exits = this.svc.exits();
		return {
			van: exits.filter((x) => x.mode === 'VAN').length,
			responsavel: exits.filter((x) => x.mode === 'RESPONSAVEL').length,
		};
	}

	get reportRows() {
		if (this.reportGrade === 'all') return this.svc.exits();
		// O filtro usa o rótulo da turma (ex.: "5º Ano A").
		const match = /^(\d+º Ano) ([AB])$/.exec(this.reportGrade);
		const grade = match?.[1] ?? this.reportGrade;
		const className = match?.[2];
		return this.svc
			.exits()
			.filter(
				(record) =>
					record.student.grade === grade &&
					(!className || record.student.class === className),
			);
	}

	get reportByGrade() {
		const grades = ['1º Ano', '2º Ano', '3º Ano', '4º Ano', '5º Ano'];
		return grades.map((grade) => ({
			grade,
			count: this.svc.exits().filter((x) => x.student.grade === grade).length,
			total: this.svc.students().filter((x) => x.grade === grade).length,
		}));
	}

	get vanStudents(): Student[] {
		return this.svc.students().filter((student) => student.isVan);
	}

	get nonVanStudents(): Student[] {
		return this.svc.students().filter((student) => !student.isVan);
	}

	get activeVanCall() {
		return this.svc.vanCall();
	}

	isQueued(student: Student): boolean {
		return this.svc.queue().some((item) => item.student.id === student.id);
	}

	initials(student: Student): string {
		if (student.avatarInitials) return student.avatarInitials;
		return student.name
			.split(' ')
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0])
			.join('')
			.toUpperCase();
	}

	time(date: Date): string {
		return date.toLocaleTimeString('pt-BR', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
	}

	short(date: Date): string {
		return date.toLocaleTimeString('pt-BR', {
			hour: '2-digit',
			minute: '2-digit',
		});
	}

	dateLabel(date: Date): string {
		return date.toLocaleDateString('pt-BR', {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
		});
	}

	onCardInput(): void {
		// Leitores que funcionam como teclado enviam o UID e pressionam Enter.
		// A consulta oficial é feita em onCardScanned() diretamente no back-end.
	}

	async onCardScanned(): Promise<void> {
		const value = this.normalizeCard(this.cardId);
		if (value) await this.handleScannedUid(value);
	}

	private normalizeCard(value: unknown): string {
		return String(value ?? '')
			.trim()
			.toUpperCase()
			.replace(/\s+/g, '');
	}

	simulateScan(student: Student): void {
		if (this.scanning || this.detected || this.isQueued(student)) return;

		this.demoOpen = false;
		this.scanning = true;
		this.confirmed = null;

		setTimeout(() => {
			this.scanning = false;
			this.detected = student;
		}, 900);
	}

	async confirmDetected(): Promise<void> {
		if (!this.detected || this.isQueued(this.detected)) return;
		const student = this.detected;
		try {
			await this.svc.callManual(student);
			this.confirmed = student;
			this.detected = null;
			this.flash = true;
			setTimeout(() => (this.flash = false), 700);
			setTimeout(() => (this.confirmed = null), 3000);
		} catch (error) {
			console.error('Falha ao registrar chamada manual', error);
			this.apiActionError = 'Não foi possível registrar a chamada no back-end.';
		}
	}

	cancelDetected(): void {
		this.detected = null;
	}

	selectManual(student: Student): void {
		if (this.isQueued(student)) return;
		this.pending = student;
		this.manualConfirmed = null;
	}

	async confirmManual(): Promise<void> {
		if (!this.pending || this.isQueued(this.pending)) return;
		const student = this.pending;
		try {
			await this.svc.callManual(student);
			this.manualConfirmed = student;
			this.pending = null;
			setTimeout(() => (this.manualConfirmed = null), 3000);
		} catch (error) {
			console.error('Falha ao registrar chamada manual', error);
			this.apiActionError =
				'Não foi possível registrar a chamada manual no back-end.';
		}
	}

	cancelManual(): void {
		this.pending = null;
	}

	/** Nome do motorista vinculado ao aluno (vazio quando não houver). */
	editDriverName(student: Student): string {
		return this.svc.driverName(student.vanDriverId);
	}

	/** Prepara a confirmação de saída de um aluno da fila. A forma de saída
	 *  (van ou responsável) é identificada automaticamente pelo vínculo do aluno. */
	prepareExit(student: Student): void {
		this.pending = student;
		this.manualConfirmed = null;
		this.exitSide =
			student.isVan && student.vanDriverId ? 'VAN' : 'RESPONSAVEL';
		this.exitGuardianName =
			student.parentName && student.parentName !== 'Não informado'
				? student.parentName
				: 'Responsável';
	}

	cancelExit(): void {
		this.pending = null;
	}

	/** Confirma a saída sem pedir nada à inspetora. */
	async confirmExit(queueId: string): Promise<void> {
		this.apiActionError = '';
		const student = this.svc
			.queue()
			.find((item) => item.id === queueId)?.student;
		if (!student) return;
		this.prepareExit(student);
		try {
			await this.svc.confirmExit(queueId, this.exitSide, this.exitGuardianName);
			this.pending = null;
		} catch (error) {
			console.error('Falha ao confirmar saída', error);
			this.apiActionError = 'Não foi possível confirmar a saída no back-end.';
		}
	}

	// ---------------------------------------------------------------
	// Cadastro de vans / motoristas
	// ---------------------------------------------------------------
	private newVanForm() {
		return { name: '', plate: '', phone: '', color: '#C8102E' };
	}

	startVanForm(): void {
		this.vanFormOpen = true;
		this.editingVanId = null;
		this.vanForm = this.newVanForm();
		this.vanError = '';
	}

	editVan(driver: VanDriver): void {
		this.vanFormOpen = true;
		this.editingVanId = driver.id;
		this.vanForm = {
			name: driver.name,
			plate: driver.plate,
			phone: driver.phone || '',
			color: driver.color,
		};
		this.vanError = '';
		this.vanMessage = '';
	}

	cancelVanForm(): void {
		this.vanFormOpen = false;
		this.editingVanId = null;
		this.vanForm = this.newVanForm();
		this.vanError = '';
	}

	saveVan(): void {
		this.vanError = '';
		this.vanMessage = '';
		if (!this.vanForm.name.trim()) {
			this.vanError = 'Informe o nome do motorista.';
			return;
		}
		const duplicated = this.svc
			.vanDrivers()
			.some(
				(driver) =>
					driver.id !== this.editingVanId &&
					driver.name.trim().toLowerCase() ===
						this.vanForm.name.trim().toLowerCase(),
			);
		if (duplicated) {
			this.vanError = 'Já existe um motorista com esse nome.';
			return;
		}
		if (this.editingVanId) {
			this.svc.updateVanDriver(this.editingVanId, this.vanForm);
			this.vanMessage = 'Motorista atualizado.';
		} else {
			this.svc.addVanDriver(this.vanForm);
			this.vanMessage = 'Motorista cadastrado.';
		}
		this.cancelVanForm();
	}

	removeVan(driver: VanDriver): void {
		if (
			!confirm(
				`Excluir o motorista ${driver.name}? Os alunos vinculados ficarão sem motorista.`,
			)
		)
			return;
		this.svc.removeVanDriver(driver.id);
		this.vanMessage = 'Motorista removido.';
		if (this.editingVanId === driver.id) this.cancelVanForm();
	}

	driverStudents(driver: VanDriver): Student[] {
		return this.svc.studentsByDriver(driver.id);
	}

	callDriver(driver: VanDriver): void {
		this.svc.callDriver(driver);
	}

	endVanCall(): void {
		this.svc.endVanCall();
	}

	onEditVanChange(isVan: boolean): void {
		// Ao desmarcar a van, o vínculo com o motorista deixa de fazer sentido.
		if (!isVan) this.editDraft.vanDriverId = undefined;
	}

	onCadastroVanChange(isVan: boolean): void {
		if (!isVan) this.cadastroDraft.vanDriverId = undefined;
	}

	editStudent(student: Student): void {
		this.editingStudent = student;
		this.editDraft = { ...student };
		this.editError = '';
		this.editMessage = '';
	}

	cancelEditStudent(): void {
		this.editingStudent = null;
		this.editDraft = {};
		this.editError = '';
	}

	onEditPhotoSelected(event: Event): void {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		if (!file.type.startsWith('image/')) {
			this.editError = 'Selecione um arquivo de imagem.';
			input.value = '';
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const img = new Image();
			img.onload = () => {
				const size = 400;
				const side = Math.min(img.width, img.height);
				const canvas = document.createElement('canvas');
				canvas.width = size;
				canvas.height = size;
				canvas
					.getContext('2d')!
					.drawImage(
						img,
						(img.width - side) / 2,
						(img.height - side) / 2,
						side,
						side,
						0,
						0,
						size,
						size,
					);
				this.editDraft.photo = canvas.toDataURL('image/jpeg', 0.82);
				this.cdr.detectChanges();
			};
			img.src = reader.result as string;
		};
		reader.readAsDataURL(file);
		input.value = '';
	}

	removeEditPhoto(): void {
		this.editDraft.photo = undefined;
	}

	async deleteStudent(student: Student): Promise<void> {
		const confirmed = window.confirm(
			`Tem certeza que deseja excluir o aluno ${student.name}? Esta ação não poderá ser desfeita.`,
		);
		if (!confirmed) return;
		this.editError = '';
		this.editMessage = '';
		try {
			await this.svc.deleteStudent(student.id);
			if (this.editingStudent?.id === student.id) this.cancelEditStudent();
			this.editMessage = `${student.name} foi excluído(a).`;
		} catch (error) {
			console.error('Falha ao excluir aluno', error);
			this.editError =
				'Não foi possível excluir pela API. Verifique se o back-end implementa DELETE /api/alunos/{id}.';
		}
	}

	async saveStudentEdit(): Promise<void> {
		this.editError = '';
		this.editMessage = '';
		if (!this.editingStudent || !this.editDraft.name?.trim()) {
			this.editError = 'Informe o nome do aluno.';
			return;
		}
		if (this.editDraft.isVan && !this.editDraft.vanDriverId) {
			this.editError = 'Selecione o motorista da van do aluno.';
			return;
		}
		try {
			const updated: Student = {
				...this.editingStudent,
				...this.editDraft,
				name: this.editDraft.name.trim(),
				grade: this.editDraft.grade || '5º Ano',
				class: this.editDraft.class || 'A',
			} as Student;
			await this.svc.updateStudent(updated);
			this.editMessage = 'Dados atualizados.';
			this.editingStudent = null;
			this.editDraft = {};
		} catch (error) {
			console.error('Falha ao editar aluno', error);
			this.editError =
				'Não foi possível salvar a edição na API. Confira o endpoint PUT /api/alunos/{id}.';
		}
	}

	resetCadastro(): void {
		this.cadastroDraft = this.newCadastroDraft();
		this.cadastroError = '';
	}

	get cadastroValid(): boolean {
		const d = this.cadastroDraft;
		return !!(
			d.name?.trim() &&
			d.grade &&
			d.class?.trim() &&
			d.email?.trim() &&
			d.cpf?.trim() &&
			d.birthDate &&
			d.parentName?.trim() &&
			d.guardianPhone?.trim()
		);
	}

	onPhotoSelected(event: Event): void {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = () => {
			const img = new Image();
			img.onload = () => {
				// Recorta no centro (quadrado) e reduz para não pesar no armazenamento.
				const size = 400;
				const side = Math.min(img.width, img.height);
				const canvas = document.createElement('canvas');
				canvas.width = size;
				canvas.height = size;
				canvas
					.getContext('2d')!
					.drawImage(
						img,
						(img.width - side) / 2,
						(img.height - side) / 2,
						side,
						side,
						0,
						0,
						size,
						size,
					);
				this.cadastroDraft.photo = canvas.toDataURL('image/jpeg', 0.82);
				this.cdr.detectChanges();
			};
			img.src = reader.result as string;
		};
		reader.readAsDataURL(file);
		input.value = '';
	}

	removePhoto(): void {
		this.cadastroDraft.photo = undefined;
	}

	async saveCadastro(): Promise<void> {
		this.cadastroMsg = '';
		this.cadastroError = '';
		if (!this.cadastroValid) return;

		const d = this.cadastroDraft;
		const rfid = this.normalizeCard(d.rfidCard);
		if (
			rfid &&
			this.svc.students().some((s) => this.normalizeCard(s.rfidCard) === rfid)
		) {
			this.cadastroError =
				'Este cartão RFID já está cadastrado para outro aluno.';
			return;
		}

		try {
			const student = await this.svc.addStudent({
				name: d.name!.trim(),
				grade: d.grade!,
				class: d.class!.trim().toUpperCase(),
				parentName: d.parentName!.trim(),
				parentRelation: d.parentRelation || 'Mãe',
				email: d.email?.trim(),
				cpf: d.cpf?.trim(),
				birthDate: d.birthDate,
				guardianPhone: d.guardianPhone?.trim(),
				rfidCard: rfid,
				isVan: !!d.isVan,
				vanDriverId: d.isVan ? d.vanDriverId : undefined,
				avatarColor: d.avatarColor || '#C8102E',
				photo: d.photo,
			});
			this.cadastroMsg = `${student.name} foi cadastrado(a) com sucesso.`;
			this.cadastroDraft = this.newCadastroDraft();
		} catch (error) {
			console.error('Falha ao cadastrar aluno na API', error);
			this.cadastroError =
				'Não foi possível salvar o aluno no back-end. Verifique se a API está ativa e se o endpoint POST /api/alunos está configurado.';
		}
	}

	private newCadastroDraft(): Partial<Student> {
		return {
			name: '',
			grade: '',
			class: '',
			parentName: '',
			parentRelation: 'Mãe',
			email: '',
			cpf: '',
			birthDate: '',
			guardianPhone: '',
			rfidCard: '',
			isVan: false,
			vanDriverId: undefined,
			avatarColor: '#C8102E',
			photo: undefined,
		};
	}

	printReport(): void {
		window.print();
	}
}
