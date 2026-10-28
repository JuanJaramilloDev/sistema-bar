import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { DatePipe } from '@angular/common';
import {
  NonNullableFormBuilder,
  ReactiveFormsModule,
  Validators
} from '@angular/forms';
import { Promoters as PromotersApi } from '../../../core/services/promoters';
import { humanizeDbError, type DbError } from '../../../core/services/supabase';
import { Modal } from '../../../shared/components/modal/modal';
import { Loading } from '../../../shared/components/loading/loading';
import { Empty } from '../../../shared/components/empty/empty';
import { Icon } from '../../../shared/components/icon/icon';
import { CurrencyPipe } from '../../../shared/pipes/currency-pipe';
import { jornadaOf, jornadaStartOf } from '../../../core/utils/jornada';
import type {
  Promoter,
  PromoterPayout,
  PromoterReportRow
} from '../../../core/models/promoter';

import { ResponsiveTable } from '../../../shared/directives/responsive-table';
type ViewState = 'loading' | 'ready' | 'error';
type Notice = { text: string; kind: 'ok' | 'err' };

/** Fila del reporte con la comisión ya calculada. */
interface ReportLine extends PromoterReportRow {
  commission: number;
  /** Pago registrado de este mes (null = aún no se le paga). */
  payout: PromoterPayout | null;
}

/**
 * Gestión de promotoras (solo administrador): código + nombre. El código se
 * elige en Ventas al registrar una venta; a fin de mes se calcula su porcentaje.
 * Desactivar oculta el código del POS sin perder las ventas ya asociadas.
 *
 * Comisión: un solo porcentaje para todas (editable aquí). Solo cuentan las
 * ventas del mes que ya están pagadas por completo; las que aún deben se
 * muestran como "pendientes" y entran cuando el cliente termina de pagar.
 *
 * Pagos: por cada promotora y mes se registra si ya se le pagó la comisión
 * (monto + nota), para saber a quién se le pagó y a quién no.
 */
@Component({
  selector: 'app-admin-promoters',
  imports: [ResponsiveTable, DatePipe, ReactiveFormsModule, Modal, Loading, Empty, Icon, CurrencyPipe],
  templateUrl: './promoters.html',
  styleUrl: './promoters.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Promoters {

  private readonly api = inject(PromotersApi);
  private readonly fb = inject(NonNullableFormBuilder);

  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  readonly state = signal<ViewState>('loading');
  readonly all = signal<Promoter[]>([]);
  readonly search = signal('');
  readonly notice = signal<Notice | null>(null);

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const list = this.all();
    if (!q) {
      return list;
    }
    return list.filter(
      (p) => p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
    );
  });

  // --- formulario (crear / editar) ---
  readonly formOpen = signal(false);
  readonly editing = signal<Promoter | null>(null);
  readonly saving = signal(false);
  readonly formError = signal('');
  readonly form = this.fb.group({
    code: this.fb.control('', [Validators.required, Validators.maxLength(30)]),
    name: this.fb.control('', [Validators.required, Validators.maxLength(80)])
  });

  // --- confirmación de borrado ---
  readonly deleteTarget = signal<Promoter | null>(null);
  readonly deleting = signal(false);
  readonly deleteError = signal('');

  // --- fila ocupada (activar/desactivar) ---
  readonly busyId = signal<number | null>(null);

  // --- comisión (porcentaje global) ---
  readonly pct = signal(0);
  readonly pctDraft = signal('');
  readonly pctSaving = signal(false);
  readonly pctDirty = computed(() => this.pctDraft() !== String(this.pct()));

  // --- reporte del mes ---
  /** Mes del reporte en formato `YYYY-MM` (input type="month"). */
  readonly month = signal(currentMonth());
  readonly reportState = signal<ViewState>('loading');
  readonly report = signal<PromoterReportRow[]>([]);
  readonly payouts = signal<PromoterPayout[]>([]);

  readonly reportLines = computed<ReportLine[]>(() => {
    const pct = this.pct();
    const byPromoter = new Map(this.payouts().map((p) => [p.promoter_id, p]));
    return this.report().map((r) => ({
      ...r,
      commission: Math.round((r.paidTotal * pct) / 100),
      payout: byPromoter.get(r.promoterId) ?? null
    }));
  });

  // --- registrar pago de comisión ---
  readonly payTarget = signal<ReportLine | null>(null);
  readonly payAmount = signal(0);
  readonly payNotes = signal('');
  readonly paySaving = signal(false);
  readonly payError = signal('');
  readonly payBusyId = signal<number | null>(null);

  readonly reportTotals = computed(() =>
    this.reportLines().reduce(
      (acc, r) => ({
        paid: acc.paid + r.paidTotal,
        commission: acc.commission + r.commission,
        pending: acc.pending + r.pendingTotal,
        pendingCount: acc.pendingCount + r.pendingCount,
        paidOut: acc.paidOut + (r.payout?.amount ?? 0),
        toPay: acc.toPay + (r.payout ? 0 : r.commission)
      }),
      { paid: 0, commission: 0, pending: 0, pendingCount: 0, paidOut: 0, toPay: 0 }
    )
  );

  constructor() {
    void this.load();
    void this.loadPct();
    void this.loadReport();
  }

  async load(): Promise<void> {
    this.state.set('loading');
    try {
      this.all.set(await this.api.list());
      this.state.set('ready');
    } catch (err) {
      console.error('[promotoras] cargar:', err);
      this.state.set('error');
    }
  }

  openCreate(): void {
    this.editing.set(null);
    this.formError.set('');
    this.form.reset({ code: '', name: '' });
    this.formOpen.set(true);
  }

  openEdit(promoter: Promoter): void {
    this.editing.set(promoter);
    this.formError.set('');
    this.form.reset({ code: promoter.code, name: promoter.name });
    this.formOpen.set(true);
  }

  closeForm(): void {
    if (!this.saving()) {
      this.formOpen.set(false);
    }
  }

  async submit(): Promise<void> {
    this.formError.set('');
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const { code, name } = this.form.getRawValue();
    const editingId = this.editing()?.id ?? null;
    const normalized = code.replace(/\s+/g, '').toUpperCase();

    if (!normalized) {
      this.form.controls.code.markAsTouched();
      return;
    }

    const duplicate = this.all().some(
      (p) => p.id !== editingId && p.code.toUpperCase() === normalized
    );
    if (duplicate) {
      this.formError.set('Ese código ya está asignado a otra promotora.');
      return;
    }

    this.saving.set(true);
    try {
      const input = { code: normalized, name };
      if (editingId) {
        const updated = await this.api.update(editingId, input);
        this.all.update((list) =>
          [...list.map((p) => (p.id === updated.id ? updated : p))].sort(byCode)
        );
        this.flash('Promotora actualizada.', 'ok');
      } else {
        const created = await this.api.create(input);
        this.all.update((list) => [...list, created].sort(byCode));
        this.flash('Promotora creada correctamente.', 'ok');
      }
      this.formOpen.set(false);
      void this.loadReport();
    } catch (err) {
      const dbError = err as DbError;
      console.error('[promotoras] guardar:', dbError);
      this.formError.set(
        dbError.code === '23505'
          ? 'Ese código ya está asignado a otra promotora.'
          : humanizeDbError(dbError, 'No fue posible guardar la promotora.')
      );
    } finally {
      this.saving.set(false);
    }
  }

  async toggleActive(promoter: Promoter): Promise<void> {
    this.busyId.set(promoter.id);
    try {
      await this.api.setActive(promoter.id, !promoter.active);
      this.all.update((list) =>
        list.map((p) => (p.id === promoter.id ? { ...p, active: !p.active } : p))
      );
      this.flash(
        promoter.active ? 'Promotora desactivada.' : 'Promotora activada.',
        'ok'
      );
    } catch (err) {
      console.error('[promotoras] estado:', err);
      this.flash(
        humanizeDbError(err as DbError, 'No fue posible cambiar el estado.'),
        'err'
      );
    } finally {
      this.busyId.set(null);
    }
  }

  askDelete(promoter: Promoter): void {
    this.deleteError.set('');
    this.deleteTarget.set(promoter);
  }

  cancelDelete(): void {
    if (!this.deleting()) {
      this.deleteTarget.set(null);
    }
  }

  async confirmDelete(): Promise<void> {
    const target = this.deleteTarget();
    if (!target || this.deleting()) {
      return;
    }
    this.deleting.set(true);
    this.deleteError.set('');
    try {
      await this.api.remove(target.id);
      this.all.update((list) => list.filter((p) => p.id !== target.id));
      this.deleteTarget.set(null);
      this.flash('Promotora eliminada.', 'ok');
      void this.loadReport();
    } catch (err) {
      const dbError = err as DbError;
      console.error('[promotoras] eliminar:', dbError);
      this.deleteError.set(
        dbError.code === '23503'
          ? 'No se puede eliminar: ya tiene ventas o pagos registrados. Desactívala en su lugar.'
          : humanizeDbError(dbError, 'No fue posible eliminar la promotora.')
      );
    } finally {
      this.deleting.set(false);
    }
  }

  // ------------------------------------------------------------- comisión ---

  async loadPct(): Promise<void> {
    try {
      const pct = await this.api.commissionPct();
      this.pct.set(pct);
      this.pctDraft.set(String(pct));
    } catch (err) {
      console.error('[promotoras] porcentaje:', err);
    }
  }

  async savePct(): Promise<void> {
    const value = Number(this.pctDraft().replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      this.flash('El porcentaje debe estar entre 0 y 100.', 'err');
      return;
    }
    const pct = Math.round(value * 100) / 100;
    this.pctSaving.set(true);
    try {
      await this.api.setCommissionPct(pct);
      this.pct.set(pct);
      this.pctDraft.set(String(pct));
      this.flash(`Comisión actualizada a ${pct}%.`, 'ok');
    } catch (err) {
      console.error('[promotoras] guardar porcentaje:', err);
      this.flash(
        humanizeDbError(err as DbError, 'No fue posible guardar el porcentaje.'),
        'err'
      );
    } finally {
      this.pctSaving.set(false);
    }
  }

  // -------------------------------------------------------------- reporte ---

  onMonth(value: string): void {
    if (!value) {
      return;
    }
    this.month.set(value);
    void this.loadReport();
  }

  async loadReport(): Promise<void> {
    this.reportState.set('loading');
    const [year, month] = this.month().split('-').map(Number);
    try {
      const [report, payouts] = await Promise.all([
        this.api.report(
          jornadaStartOf(new Date(year, month - 1, 1)),
          jornadaStartOf(new Date(year, month, 1))
        ),
        this.api.payouts(this.period())
      ]);
      this.report.set(report);
      this.payouts.set(payouts);
      this.reportState.set('ready');
    } catch (err) {
      console.error('[promotoras] reporte:', err);
      this.reportState.set('error');
    }
  }

  // ---------------------------------------------------------------- pagos ---

  /** Mes del reporte como fecha `YYYY-MM-01` (clave de `promoter_payouts`). */
  private period(): string {
    return `${this.month()}-01`;
  }

  openPay(line: ReportLine): void {
    this.payError.set('');
    this.payAmount.set(line.commission);
    this.payNotes.set('');
    this.payTarget.set(line);
  }

  closePay(): void {
    if (!this.paySaving()) {
      this.payTarget.set(null);
    }
  }

  async confirmPay(): Promise<void> {
    const target = this.payTarget();
    if (!target || this.paySaving()) {
      return;
    }
    const amount = Number(this.payAmount());
    if (!Number.isFinite(amount) || amount < 0) {
      this.payError.set('El monto no es válido.');
      return;
    }
    this.paySaving.set(true);
    this.payError.set('');
    try {
      const payout = await this.api.markPaid(
        target.promoterId,
        this.period(),
        amount,
        this.payNotes()
      );
      this.payouts.update((list) => [...list, payout]);
      this.payTarget.set(null);
      this.flash(`Pago registrado a ${target.name}.`, 'ok');
    } catch (err) {
      const dbError = err as DbError;
      console.error('[promotoras] pagar:', dbError);
      this.payError.set(
        dbError.code === '23505'
          ? 'Ya hay un pago registrado para esta promotora en este mes.'
          : humanizeDbError(dbError, 'No fue posible registrar el pago.')
      );
    } finally {
      this.paySaving.set(false);
    }
  }

  async undoPay(line: ReportLine): Promise<void> {
    if (!line.payout) {
      return;
    }
    const payoutId = line.payout.id;
    this.payBusyId.set(line.promoterId);
    try {
      await this.api.undoPayout(payoutId);
      this.payouts.update((list) => list.filter((p) => p.id !== payoutId));
      this.flash(`Pago de ${line.name} deshecho.`, 'ok');
    } catch (err) {
      console.error('[promotoras] deshacer pago:', err);
      this.flash(humanizeDbError(err as DbError, 'No fue posible deshacer el pago.'), 'err');
    } finally {
      this.payBusyId.set(null);
    }
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

/** Mes actual (hora local) como `YYYY-MM`. */
function currentMonth(): string {
  const now = jornadaOf(new Date());
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function byCode(a: Promoter, b: Promoter): number {
  return a.code.localeCompare(b.code);
}
