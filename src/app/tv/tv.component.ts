import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, ViewChild, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PortariaService } from '../core/portaria.service';

interface TvItem {
  key: string;
  kind: 'student' | 'van';
  name: string;
  line: string;
  photo?: string;
  color: string;
  initials: string;
}

const GAP = 22;
const PAD = 26;

@Component({
  selector: 'app-tv',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="tv-screen">
      <header class="tv-top">
        <div class="brand">
          <div class="brand-mark">EM</div>
          <div>
            <strong>ESCOLA MUNICIPAL</strong>
            <span>SAÍDA DE ALUNOS</span>
          </div>
        </div>
        <strong class="tv-clock">{{ now() | date: 'HH:mm:ss' }}</strong>
      </header>

      <div class="tv-stage" #stage>
        <div class="tv-grid" *ngIf="items().length; else idle" [style.--size]="size() + 'px'">
          <div class="tv-square" *ngFor="let item of items(); trackBy: trackKey" [style.background]="item.color">
            <img *ngIf="item.photo" [src]="item.photo" alt="">
            <span class="tv-initials" *ngIf="!item.photo">{{ item.initials }}</span>
            <div class="tv-caption">
              <small>{{ item.kind === 'van' ? 'Motorista da van' : 'Chamado' }}</small>
              <strong>{{ item.name }}</strong>
              <span>{{ item.line }}</span>
            </div>
          </div>
        </div>

        <ng-template #idle>
          <div class="tv-idle">
            <h2>Nenhuma chamada no momento</h2>
            <p>Os alunos chamados aparecerão aqui.</p>
          </div>
        </ng-template>
      </div>

      <div class="tv-tools">
        <button type="button" (click)="svc.toggleTheme()">{{ svc.theme() === 'dark' ? '☀ Claro' : '☾ Escuro' }}</button>
        <button type="button" (click)="fullscreen()">⛶ Tela cheia</button>
      </div>
    </div>
  `
})
export class TvComponent implements AfterViewInit, OnDestroy {
  @ViewChild('stage') private stage!: ElementRef<HTMLElement>;

  readonly now = signal(new Date());
  private readonly box = signal({ w: window.innerWidth, h: window.innerHeight * 0.85 });
  private observer?: ResizeObserver;

  readonly items = computed<TvItem[]>(() => {
    const list: TvItem[] = this.svc.queue().map(q => ({
      key: q.id,
      kind: 'student',
      name: q.student.name,
      line: `${q.student.grade} • Turma ${q.student.class}`,
      photo: q.student.photo,
      color: q.student.avatarColor,
      initials: this.initials(q.student.name)
    }));

    const van = this.svc.vanCall();
    if (van) {
      list.push({
        key: `van-${van.driver.id}-${van.calledAt.getTime()}`,
        kind: 'van',
        name: van.driver.name,
        line: `Placa ${van.driver.plate} — compareça à portaria`,
        color: van.driver.color,
        initials: this.initials(van.driver.name)
      });
    }
    return list;
  });

  /** Tamanho do cartão: o maior quadrado que permite encaixar todos na tela. */
  readonly size = computed(() => {
    const count = this.items().length;
    if (!count) return 0;
    const { w, h } = this.box();
    const width = Math.max(w - PAD * 2, 100);
    const height = Math.max(h - PAD * 2, 100);
    let best = 0;
    for (let cols = 1; cols <= count; cols++) {
      const rows = Math.ceil(count / cols);
      const side = Math.min(
        (width - GAP * (cols - 1)) / cols,
        (height - GAP * (rows - 1)) / rows
      );
      if (side > best) best = side;
    }
    return Math.floor(best);
  });

  private readonly clockTimer = setInterval(() => this.now.set(new Date()), 1000);

  constructor(public svc: PortariaService, private zone: NgZone) { }

  ngAfterViewInit(): void {
    // Garante a carga dos alunos também na TV (janela separada), para que
    // nome/turma apareçam mesmo se o serviço já estiver instanciado.
    if (!this.svc.students().length) void this.svc.loadStudents();
    const el = this.stage.nativeElement;
    const update = () => this.box.set({ w: el.clientWidth, h: el.clientHeight });
    update();
    this.observer = new ResizeObserver(() => this.zone.run(update));
    this.observer.observe(el);
  }

  ngOnDestroy(): void {
    clearInterval(this.clockTimer);
    this.observer?.disconnect();
  }

  trackKey = (_: number, item: TvItem) => item.key;

  fullscreen(): void {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen?.();
    }
  }

  private initials(name: string): string {
    return name.split(' ').filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();
  }
}
