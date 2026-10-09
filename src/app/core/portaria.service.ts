import { Injectable, effect, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL, WS_URL, WS_TOPIC } from './api.config';
import { ExitRecord, QueueItem, Student, VanCall, VanDriver } from '../models/models';

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
type StudentMeta = { grade?: string; class?: string; parentName?: string; parentRelation?: string; guardianPhone?: string; email?: string; cpf?: string; birthDate?: string; isVan?: boolean; avatarColor?: string; photo?: string; };


@Injectable({ providedIn: 'root' })
export class PortariaService {
  readonly students = signal<Student[]>([]);
  readonly studentsLoading = signal(false);
  readonly apiError = signal('');
  readonly queue = signal<QueueItem[]>([]);
  readonly exits = signal<ExitRecord[]>([]);
  readonly vanDrivers = signal<VanDriver[]>([
    { id: 'VAN001', name: 'Marcos Almeida', plate: 'ABC-1D23', color: '#C8102E' },
    { id: 'VAN002', name: 'Patrícia Ramos', plate: 'DEF-4G56', color: '#1769AA' }
  ]);
  readonly vanCall = signal<VanCall | null>(null);
  readonly theme = signal<Theme>(this.readTheme());

  private queueRefreshTimer?: ReturnType<typeof setInterval>;
  private ws?: WebSocket;
  private wsReconnectTimer?: ReturnType<typeof setTimeout>;
  private wsRetryDelay = 2000;
  readonly websocketConnected = signal(false);

  constructor(private readonly http: HttpClient) {
    this.loadState();
    void this.loadStudents();
    void this.loadQueue();
    // A fila é atualizada por WebSocket em tempo real. A consulta periódica
    // permanece como alternativa caso a conexão não esteja disponível.
    this.queueRefreshTimer = setInterval(() => {
      if (!this.websocketConnected()) void this.loadQueue();
    }, 10000);
    this.connectWebSocket();

    effect(() => document.documentElement.setAttribute('data-theme', this.theme()));

    window.addEventListener('storage', event => {
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
        // Spring STOMP over WebSocket: establish the STOMP session.
        socket.send('CONNECT\\naccept-version:1.2,1.1\\nheart-beat:10000,10000\\n\\n\\u0000');
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        const frames = String(event.data).split('\\u0000');
        for (const rawFrame of frames) {
          const frame = rawFrame.trim();
          if (!frame) continue;
          const separator = frame.indexOf('\\n\\n');
          const headerText = separator >= 0 ? frame.slice(0, separator) : frame;
          const body = separator >= 0 ? frame.slice(separator + 2) : '';
          const command = headerText.split(/\\r?\\n/, 1)[0];

          if (command === 'CONNECTED') {
            socket.send(`SUBSCRIBE\\nid:portaria-patio\\ndestination:${WS_TOPIC}\\nack:auto\\n\\n\\u0000`);
            this.websocketConnected.set(true);
          } else if (command === 'MESSAGE') {
            // O evento informa que houve mudança na chamada; a fila oficial
            // continua vindo do endpoint REST /api/chamadas.
            void this.loadQueue();
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
        if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = setTimeout(() => this.connectWebSocket(), this.wsRetryDelay);
        this.wsRetryDelay = Math.min(this.wsRetryDelay * 2, 30000);
      };
    } catch (error) {
      this.websocketConnected.set(false);
      console.error('Não foi possível iniciar o WebSocket da portaria.', error);
    }
  }

  toggleTheme(): void {
    const next: Theme = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* armazenamento opcional */ }
  }

  private readTheme(): Theme {
    try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  }

  private studentFromApi(aluno: AlunoApi, cards: CartaoApi[]): Student {
    const card = cards.find(c => c.ativo && c.tipo === 'ALUNO' && Number(c.alunoId) === Number(aluno.id));
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
      avatarColor: meta.avatarColor || '#C8102E',
      avatarInitials: name.split(' ').filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase(),
      photo: meta.photo || aluno.fotoUrl || undefined,
      email: aluno.email || meta.email || '', cpf: aluno.cpf || meta.cpf || '', birthDate: aluno.dataNascimento || meta.birthDate || '', guardianPhone: meta.guardianPhone || ''
    };
  }

  async loadStudents(): Promise<void> {
    this.studentsLoading.set(true);
    this.apiError.set('');
    try {
      const [alunos, cartoes] = await Promise.all([
        firstValueFrom(this.http.get<AlunoApi[]>(`${API_BASE_URL}/alunos`)),
        firstValueFrom(this.http.get<CartaoApi[]>(`${API_BASE_URL}/cartoes`)).catch(() => [] as CartaoApi[])
      ]);
      this.students.set(alunos.map(aluno => this.studentFromApi(aluno, cartoes)));
    } catch (error) {
      this.apiError.set('Não foi possível carregar os alunos. Confira o IP/porta em src/app/core/api.config.ts e se o Spring Boot está acessível.');
      console.error('Falha ao carregar alunos da API', error);
    } finally {
      this.studentsLoading.set(false);
    }
  }

  private readStudentMeta(): Record<string, StudentMeta> {
    try { return JSON.parse(localStorage.getItem(STUDENT_META_KEY) ?? '{}'); } catch { return {}; }
  }

  private saveStudentMeta(id: string, data: StudentMeta): void {
    const all = this.readStudentMeta(); all[id] = { ...(all[id] ?? {}), ...data };
    try { localStorage.setItem(STUDENT_META_KEY, JSON.stringify(all)); } catch { /* armazenamento opcional */ }
  }

  async addStudent(data: Omit<Student, 'id'>): Promise<Student> {
    const payload = {
      nome: data.name.trim(), email: data.email?.trim() || null, cpf: data.cpf?.trim() || null,
      dataNascimento: data.birthDate || null, matricula: `ALU${Date.now()}`,
      fotoUrl: data.photo && /^https?:\/\//i.test(data.photo) ? data.photo : null, ativo: true
    };
    const created = await firstValueFrom(this.http.post<AlunoApi>(`${API_BASE_URL}/alunos`, payload));
    this.saveStudentMeta(String(created.id), { grade: data.grade, class: data.class, parentName: data.parentName, parentRelation: data.parentRelation, guardianPhone: data.guardianPhone, email: data.email, cpf: data.cpf, birthDate: data.birthDate, isVan: data.isVan, avatarColor: data.avatarColor, photo: data.photo });
    if (data.rfidCard?.trim()) {
      await firstValueFrom(this.http.post<CartaoApi>(`${API_BASE_URL}/cartoes`, { uid: data.rfidCard.trim().toUpperCase().replace(/\s+/g, ''), tipo: 'ALUNO', ativo: true, alunoId: created.id }));
    }
    await this.loadStudents();
    const saved = this.students().find(student => student.id === String(created.id));
    if (!saved) throw new Error('O aluno foi criado, mas não apareceu na listagem após atualizar.');
    return saved;
  }

  async deleteStudent(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`${API_BASE_URL}/alunos/${encodeURIComponent(id)}`));
    const all = this.readStudentMeta();
    delete all[id];
    try { localStorage.setItem(STUDENT_META_KEY, JSON.stringify(all)); } catch { /* armazenamento opcional */ }
    await this.loadStudents();
  }

  async updateStudent(student: Student): Promise<void> {
    const payload = { nome: student.name.trim(), email: student.email?.trim() || null, cpf: student.cpf?.trim() || null,
      dataNascimento: student.birthDate || null, matricula: `ALU${student.id}`, fotoUrl: student.photo && /^https?:\/\//i.test(student.photo) ? student.photo : null, ativo: true };
    await firstValueFrom(this.http.put(`${API_BASE_URL}/alunos/${encodeURIComponent(student.id)}`, payload));
    this.saveStudentMeta(student.id, { grade: student.grade, class: student.class, parentName: student.parentName, parentRelation: student.parentRelation, guardianPhone: student.guardianPhone, email: student.email, cpf: student.cpf, birthDate: student.birthDate, isVan: student.isVan, avatarColor: student.avatarColor, photo: student.photo });
    await this.loadStudents();
  }

  async processRfidRead(uid: string, ponto: 'PORTARIA' | 'PORTAO' = 'PORTARIA'): Promise<LeituraApi> {
    const result = await firstValueFrom(this.http.post<LeituraApi>(`${API_BASE_URL}/leituras`, { uid, ponto }));
    await this.loadQueue();
    return result;
  }

  async confirmGuardianRead(uid: string, alunoId: number): Promise<void> {
    await firstValueFrom(this.http.post<ChamadaApi>(`${API_BASE_URL}/leituras/confirmacao`, { uid, alunoId }));
    await this.loadQueue();
  }

  async loadQueue(): Promise<void> {
    try {
      const calls = await firstValueFrom(this.http.get<ChamadaApi[]>(`${API_BASE_URL}/chamadas`));
      if (!Array.isArray(calls)) return;
      const students = this.students();
      const queue = calls.map(call => {
        const existing = students.find(student => student.id === String(call.alunoId));
        const name = call.nomeExibicao || existing?.name || 'Aluno';
        const student: Student = existing ?? {
          id: String(call.alunoId), name, grade: 'Não informado', class: '—',
          parentName: 'Não informado', parentRelation: 'Responsável', rfidCard: '',
          isVan: false, avatarColor: '#C8102E', photo: call.fotoUrl || undefined,
          avatarInitials: name.split(' ').filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase()
        };
        return { id: String(call.id), student: { ...student, name: call.nomeExibicao || student.name, photo: call.fotoUrl || student.photo }, queuedAt: new Date(call.criadoEm) };
      });
      this.queue.set(queue);
    } catch (error) {
      // Mantém a interface utilizável, mas exibe o erro de API em vez de simular a fila.
      this.apiError.set('Não foi possível atualizar a fila de chamadas. Verifique a API /api/chamadas.');
      console.error('Falha ao carregar fila da API', error);
    }
  }

  async callManual(student: Student): Promise<void> {
    await firstValueFrom(this.http.post<ChamadaApi>(`${API_BASE_URL}/chamadas/manual`, { alunoId: Number(student.id) }));
    await this.loadQueue();
  }

  async confirmExit(queueId: string): Promise<void> {
    const item = this.queue().find(x => x.id === queueId);
    await firstValueFrom(this.http.post<ChamadaApi>(`${API_BASE_URL}/chamadas/${encodeURIComponent(queueId)}/saida`, {}));
    await this.loadQueue();
    if (item) this.exits.update(items => [{ id: `EX-${Date.now()}`, student: item.student, exitAt: new Date() }, ...items]);
    this.saveState();
  }

  studentsByDriver(_driverId: string): Student[] {
    // O back-end atual não possui endpoint/relacionamento para alunos de cada van.
    return [];
  }

  callDriver(driver: VanDriver): void {
    this.vanCall.set({ driver, calledAt: new Date() });
    this.saveState();
  }

  endVanCall(): void {
    this.vanCall.set(null);
    this.saveState();
  }

  private saveState(): void {
    const call = this.vanCall();
    const data = {
      exits: this.exits().map(i => ({ id: i.id, student: i.student, exitAt: i.exitAt.toISOString() })),
      vanCall: call ? { driverId: call.driver.id, calledAt: call.calledAt.toISOString() } : null
    };
    try { localStorage.setItem(STATE_KEY, JSON.stringify(data)); } catch { /* armazenamento opcional */ }
  }

  private loadState(): void {
    let data: any = null;
    try { data = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null'); } catch { /* JSON inválido */ }
    const today = new Date().toDateString();
    const exits: ExitRecord[] = (data?.exits ?? [])
      .filter((i: any) => i.student && new Date(i.exitAt).toDateString() === today)
      .map((i: any) => ({ id: i.id, student: i.student, exitAt: new Date(i.exitAt) }));
    const driver = this.vanDrivers().find(d => d.id === data?.vanCall?.driverId);
    const vanCall: VanCall | null = driver && data?.vanCall
      ? { driver, calledAt: new Date(data.vanCall.calledAt) }
      : null;
    this.exits.set(exits);
    this.vanCall.set(vanCall);
  }
}
