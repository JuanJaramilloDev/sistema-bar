import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal
} from '@angular/core';
import { FixedExpenses as FixedExpensesApi } from '../../../core/services/fixed-expenses';
import { humanizeDbError, type DbError } from '../../../core/services/supabase';
import { CurrencyPipe } from '../../../shared/pipes/currency-pipe';
import { Loading } from '../../../shared/components/loading/loading';
import { Empty } from '../../../shared/components/empty/empty';
import { Modal } from '../../../shared/components/modal/modal';
import { Icon } from '../../../shared/components/icon/icon';
import type { FixedExpense } from '../../../core/models/fixed-expense';

import { ResponsiveTable } from '../../../shared/directives/responsive-table';
type ViewState = 'loading' | 'ready' | 'error';

/** El cierre semanal aparta la cuarta parte del valor mensual. */
export const WEEKS_PER_MONTH = 4;

/** Parte semanal de un valor mensual. */
export function weeklyShare(monthly: number): number {
  return Math.round(monthly / WEEKS_PER_MONTH);
}

/**
 * Gastos fijos mensuales (sección dentro de Cierres, solo admin). Avisa al
 * padre con `changed` cada vez que la lista cambia, para recalcular el cierre.
 */
@Component({
  selector: 'app-fixed-expenses',
  imports: [ResponsiveTable, CurrencyPipe, Loading, Empty, Modal, Icon],
  templateUrl: './fixed-expenses.html',
  styleUrl: './fixed-expenses.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FixedExpenses {

  private readonly api = inject(FixedExpensesApi);

  readonly changed = output<FixedExpense[]>();

  readonly state = signal<ViewState>('loading');
  readonly all = signal<FixedExpense[]>([]);
  readonly error = signal('');

  readonly monthlyTotal = computed(() =>
    this.all().filter((e) => e.active).reduce((acc, e) => acc + e.monthly_amount, 0)
  );
  readonly weeklyTotal = computed(() => weeklyShare(this.monthlyTotal()));

  // --- formulario ---
  readonly formOpen = signal(false);
  readonly editing = signal<FixedExpense | null>(null);
  readonly name = signal('');
  readonly amount = signal(0);
  readonly saving = signal(false);
  readonly formError = signal('');

  readonly busyId = signal<number | null>(null);
  /** Gasto que espera el segundo clic para eliminarse. */
  readonly confirmDeleteId = signal<number | null>(null);

  protected readonly weekly = weeklyShare;

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.state.set('loading');
    try {
      this.setAll(await this.api.list());
      this.state.set('ready');
    } catch (err) {
      console.error('[gastos fijos] cargar:', err);
      this.state.set('error');
    }
  }

  openCreate(): void {
    this.editing.set(null);
    this.name.set('');
    this.amount.set(0);
    this.formError.set('');
    this.formOpen.set(true);
  }

  openEdit(e: FixedExpense): void {
    this.editing.set(e);
    this.name.set(e.name);
    this.amount.set(e.monthly_amount);
    this.formError.set('');
    this.formOpen.set(true);
  }

  closeForm(): void {
    if (!this.saving()) {
      this.formOpen.set(false);
    }
  }

  async submit(event?: Event): Promise<void> {
    event?.preventDefault();
    if (this.saving()) {
      return;
    }
    const name = this.name().trim();
    const amount = Number(this.amount());
    if (!name) {
      this.formError.set('Escribe el nombre del gasto.');
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      this.formError.set('El monto no es válido.');
      return;
    }
    this.saving.set(true);
    this.formError.set('');
    try {
      const editingId = this.editing()?.id ?? null;
      const input = { name, monthly_amount: amount };
      if (editingId) {
        const updated = await this.api.update(editingId, input);
        this.setAll(this.all().map((e) => (e.id === updated.id ? updated : e)));
      } else {
        const created = await this.api.create(input);
        this.setAll([...this.all(), created]);
      }
      this.formOpen.set(false);
    } catch (err) {
      console.error('[gastos fijos] guardar:', err);
      this.formError.set(humanizeDbError(err as DbError, 'No fue posible guardar el gasto.'));
    } finally {
      this.saving.set(false);
    }
  }

  async toggleActive(e: FixedExpense): Promise<void> {
    this.busyId.set(e.id);
    this.error.set('');
    try {
      await this.api.setActive(e.id, !e.active);
      this.setAll(this.all().map((x) => (x.id === e.id ? { ...x, active: !x.active } : x)));
    } catch (err) {
      console.error('[gastos fijos] estado:', err);
      this.error.set(humanizeDbError(err as DbError, 'No fue posible cambiar el estado.'));
    } finally {
      this.busyId.set(null);
    }
  }

  async remove(e: FixedExpense): Promise<void> {
    if (this.confirmDeleteId() !== e.id) {
      this.confirmDeleteId.set(e.id);
      return;
    }
    this.busyId.set(e.id);
    this.error.set('');
    try {
      await this.api.remove(e.id);
      this.setAll(this.all().filter((x) => x.id !== e.id));
    } catch (err) {
      console.error('[gastos fijos] eliminar:', err);
      this.error.set(humanizeDbError(err as DbError, 'No fue posible eliminar el gasto.'));
    } finally {
      this.busyId.set(null);
      this.confirmDeleteId.set(null);
    }
  }

  private setAll(list: FixedExpense[]): void {
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
    this.all.set(sorted);
    this.changed.emit(sorted);
  }
}
