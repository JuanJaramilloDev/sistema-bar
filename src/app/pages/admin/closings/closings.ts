import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Closings as ClosingsApi } from '../../../core/services/closings';
import { Promoters as PromotersApi } from '../../../core/services/promoters';
import { humanizeDbError, type DbError } from '../../../core/services/supabase';
import { CurrencyPipe } from '../../../shared/pipes/currency-pipe';
import { Loading } from '../../../shared/components/loading/loading';
import { Empty } from '../../../shared/components/empty/empty';
import { Modal } from '../../../shared/components/modal/modal';
import { FixedExpenses, WEEKS_PER_MONTH, weeklyShare } from '../fixed-expenses/fixed-expenses';
import { jornadaOf, jornadaStartOf } from '../../../core/utils/jornada';
import type {
  Closing,
  ClosingExpenseLine,
  ClosingInput,
  ClosingKind,
  ClosingPromoterLine,
  PeriodNumbers
} from '../../../core/models/closing';
import type { FixedExpense } from '../../../core/models/fixed-expense';

type ViewState = 'loading' | 'ready' | 'error';
type Notice = { text: string; kind: 'ok' | 'err' };

/** Lo que llega del servidor para el periodo (sin gastos fijos). */
interface PeriodBase extends PeriodNumbers {
  commissionPct: number;
  commissions: number;
  promoters: ClosingPromoterLine[];
}

/** Números del periodo ya con comisiones, gastos fijos, ganancia y lo que debe quedar. */
interface Statement extends PeriodBase {
  fixedExpenses: number;
  expenses: ClosingExpenseLine[];
  /** total − costo − comisiones − gastos fijos */
  profit: number;
  /** total − comisiones (= reponer + gastos fijos + ganancia) */
  shouldRemain: number;
}

const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
];

/**
 * Cierres semanales (lunes a domingo) y mensuales. Se muestra dentro de
 * Reportes (botón "Cierres").
 *
 * Arriba: el periodo elegido calculado EN VIVO (vendido, descuentos, lo que
 * toca reponer, comisiones de promotoras, ganancia y cuánto debe quedar).
 * "Guardar cierre" deja la foto en `closings`; abajo, el historial de todos
 * los cierres guardados con su detalle.
 *
 * Gastos fijos (sección `app-fixed-expenses`): el cierre mensual aparta el
 * total mensual; el semanal, la parte de la semana (mensual / 4). Se
 * restan de la ganancia para ir dejando ese dinero aparte.
 *
 * Periodos por JORNADA (de mediodía a mediodía, ver core/utils/jornada.ts):
 * la noche del domingo hasta las 3am del lunes entra en la semana que cierra.
 *
 * Reglas (las mismas que Promotoras): sin ventas devueltas por completo; la
 * comisión solo sobre ventas con código y pagadas por completo. "Reponer" usa
 * el costo ACTUAL del producto (la venta no guarda copia del costo).
 */
@Component({
  selector: 'app-closings',
  imports: [DatePipe, CurrencyPipe, Loading, Empty, Modal, FixedExpenses],
  templateUrl: './closings.html',
  styleUrl: './closings.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Closings {

  private readonly api = inject(ClosingsApi);
  private readonly promotersApi = inject(PromotersApi);
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  readonly kind = signal<ClosingKind>('month');
  /** Inicio del periodo elegido (lunes o día 1, hora local). */
  readonly start = signal<Date>(periodStart('month', jornadaOf(new Date())));
  readonly end = computed(() => periodEnd(this.kind(), this.start()));

  readonly state = signal<ViewState>('loading');
  readonly base = signal<PeriodBase | null>(null);
  /** Gastos fijos actuales (los manda la sección de gastos al cargar/cambiar). */
  readonly expenseList = signal<FixedExpense[]>([]);

  readonly statement = computed<Statement | null>(() => {
    const base = this.base();
    if (!base) {
      return null;
    }
    const weekly = this.kind() === 'week';
    const expenses = this.expenseList()
      .filter((e) => e.active && e.monthly_amount > 0)
      .map((e) => ({
        name: e.name,
        monthly_amount: e.monthly_amount,
        amount: weekly ? weeklyShare(e.monthly_amount) : e.monthly_amount
      }));
    const fixedExpenses = expenses.reduce((acc, e) => acc + e.amount, 0);
    return {
      ...base,
      fixedExpenses,
      expenses,
      profit: base.total - base.cost - base.commissions - fixedExpenses,
      shouldRemain: base.total - base.commissions
    };
  });

  readonly historyState = signal<ViewState>('loading');
  readonly history = signal<Closing[]>([]);

  readonly notes = signal('');
  readonly saving = signal(false);
  readonly notice = signal<Notice | null>(null);

  readonly detail = signal<Closing | null>(null);
  readonly deleting = signal(false);
  /** Segundo clic para eliminar un cierre (evita borrarlo por accidente). */
  readonly confirmDelete = signal(false);

  readonly label = computed(() => periodLabel(this.kind(), this.start(), this.end()));

  /** true si el periodo elegido ya terminó (cerrar antes de tiempo se permite, pero se avisa). */
  readonly periodOver = computed(() => jornadaStartOf(this.end()).getTime() <= Date.now());

  /** Cierre ya guardado para el periodo elegido (si existe). */
  readonly saved = computed(() => {
    const key = isoDate(this.start());
    return this.history().find((c) => c.kind === this.kind() && c.period_start === key) ?? null;
  });

  constructor() {
    void this.load();
    void this.loadHistory();
  }

  setKind(kind: ClosingKind): void {
    if (kind === this.kind()) {
      return;
    }
    this.kind.set(kind);
    this.start.set(periodStart(kind, jornadaOf(new Date())));
    void this.load();
  }

  move(delta: number): void {
    const s = new Date(this.start());
    if (this.kind() === 'week') {
      s.setDate(s.getDate() + 7 * delta);
    } else {
      s.setMonth(s.getMonth() + delta);
    }
    this.start.set(s);
    void this.load();
  }

  goToday(): void {
    this.start.set(periodStart(this.kind(), jornadaOf(new Date())));
    void this.load();
  }

  async load(): Promise<void> {
    this.state.set('loading');
    // Los periodos son de jornadas: empiezan y terminan al mediodía.
    const from = jornadaStartOf(this.start());
    const to = jornadaStartOf(this.end());
    // A las promotoras se les paga MENSUAL: el cierre semanal aparta la cuarta
    // parte de la comisión del mes al que pertenece la semana (igual que los
    // gastos fijos).
    const weekly = this.kind() === 'week';
    const s = this.start();
    const commissionFrom = weekly ? jornadaStartOf(new Date(s.getFullYear(), s.getMonth(), 1)) : from;
    const commissionTo = weekly ? jornadaStartOf(new Date(s.getFullYear(), s.getMonth() + 1, 1)) : to;
    try {
      const [numbers, report, pct] = await Promise.all([
        this.api.numbers(from, to),
        this.promotersApi.report(commissionFrom, commissionTo),
        this.promotersApi.commissionPct()
      ]);
      const promoters: ClosingPromoterLine[] = report
        .filter((r) => r.paidTotal > 0)
        .map((r) => {
          const monthly = Math.round((r.paidTotal * pct) / 100);
          return weekly
            ? {
                code: r.code,
                name: r.name,
                paid_total: r.paidTotal,
                commission: Math.round(monthly / WEEKS_PER_MONTH),
                monthly_commission: monthly
              }
            : { code: r.code, name: r.name, paid_total: r.paidTotal, commission: monthly };
        });
      const commissions = promoters.reduce((acc, p) => acc + p.commission, 0);
      this.base.set({ ...numbers, commissionPct: pct, commissions, promoters });
      this.notes.set(this.saved()?.notes ?? '');
      this.state.set('ready');
    } catch (err) {
      console.error('[cierres] calcular:', err);
      this.state.set('error');
    }
  }

  async loadHistory(): Promise<void> {
    this.historyState.set('loading');
    try {
      this.history.set(await this.api.list());
      this.historyState.set('ready');
      if (this.state() === 'ready') {
        this.notes.set(this.saved()?.notes ?? '');
      }
    } catch (err) {
      console.error('[cierres] historial:', err);
      this.historyState.set('error');
    }
  }

  async save(): Promise<void> {
    const st = this.statement();
    if (!st || this.saving()) {
      return;
    }
    const notes = this.notes().trim();
    const input: ClosingInput = {
      kind: this.kind(),
      period_start: isoDate(this.start()),
      period_end: isoDate(this.end()),
      sales_count: st.count,
      gross: st.gross,
      discounts: st.discounts,
      total: st.total,
      cost: st.cost,
      commission_pct: st.commissionPct,
      commissions: st.commissions,
      fixed_expenses: st.fixedExpenses,
      profit: st.profit,
      collected: st.collected,
      pending: st.pending,
      should_remain: st.shouldRemain,
      promoters: st.promoters,
      expenses: st.expenses,
      notes: notes.length ? notes : null
    };
    const updating = this.saved() !== null;
    this.saving.set(true);
    try {
      const closing = await this.api.save(input);
      this.history.update((list) =>
        [closing, ...list.filter((c) => c.id !== closing.id)].sort(byPeriodDesc)
      );
      this.flash(updating ? 'Cierre actualizado.' : 'Cierre guardado.', 'ok');
    } catch (err) {
      console.error('[cierres] guardar:', err);
      this.flash(humanizeDbError(err as DbError, 'No fue posible guardar el cierre.'), 'err');
    } finally {
      this.saving.set(false);
    }
  }

  openDetail(closing: Closing): void {
    this.confirmDelete.set(false);
    this.detail.set(closing);
  }

  closeDetail(): void {
    if (!this.deleting()) {
      this.detail.set(null);
    }
  }

  async removeDetail(): Promise<void> {
    const target = this.detail();
    if (!target || this.deleting()) {
      return;
    }
    if (!this.confirmDelete()) {
      this.confirmDelete.set(true);
      return;
    }
    this.deleting.set(true);
    try {
      await this.api.remove(target.id);
      this.history.update((list) => list.filter((c) => c.id !== target.id));
      this.detail.set(null);
      this.flash('Cierre eliminado.', 'ok');
    } catch (err) {
      console.error('[cierres] eliminar:', err);
      this.flash(humanizeDbError(err as DbError, 'No fue posible eliminar el cierre.'), 'err');
    } finally {
      this.deleting.set(false);
    }
  }

  /** Etiqueta del periodo de un cierre guardado (historial / detalle). */
  closingLabel(c: Closing): string {
    return periodLabel(c.kind, parseIsoDate(c.period_start), parseIsoDate(c.period_end));
  }

  dismissNotice(): void {
    this.notice.set(null);
  }

  private flash(text: string, kind: Notice['kind']): void {
    this.notice.set({ text, kind });
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = setTimeout(() => this.notice.set(null), 4500);
  }
}

/** Lunes de la semana de `d`, o día 1 de su mes (00:00 local). */
function periodStart(kind: ClosingKind, d: Date): Date {
  if (kind === 'month') {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const offset = (s.getDay() + 6) % 7; // lunes = 0
  s.setDate(s.getDate() - offset);
  return s;
}

/** Fin exclusivo: lunes siguiente o día 1 del mes siguiente. */
function periodEnd(kind: ClosingKind, start: Date): Date {
  return kind === 'month'
    ? new Date(start.getFullYear(), start.getMonth() + 1, 1)
    : new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
}

function periodLabel(kind: ClosingKind, start: Date, end: Date): string {
  if (kind === 'month') {
    return `${capitalize(MONTHS[start.getMonth()])} ${start.getFullYear()}`;
  }
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
  const sameMonth = start.getMonth() === last.getMonth();
  const from = sameMonth ? `${start.getDate()}` : `${start.getDate()} ${MONTHS[start.getMonth()].slice(0, 3)}`;
  return `Semana ${from} – ${last.getDate()} ${MONTHS[last.getMonth()].slice(0, 3)} ${last.getFullYear()}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `YYYY-MM-DD` en hora local. */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseIsoDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function byPeriodDesc(a: Closing, b: Closing): number {
  return b.period_start.localeCompare(a.period_start) || a.kind.localeCompare(b.kind);
}
