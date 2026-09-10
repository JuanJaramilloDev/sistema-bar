import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators
} from '@angular/forms';
import { Auth } from '../../../core/services/auth';
import { Inventory as InventoryApi } from '../../../core/services/inventory';
import { humanizeDbError, type DbError } from '../../../core/services/supabase';
import { Modal } from '../../../shared/components/modal/modal';
import { Loading } from '../../../shared/components/loading/loading';
import { Empty } from '../../../shared/components/empty/empty';
import { Icon } from '../../../shared/components/icon/icon';
import {
  stockStatus,
  type InventoryRow,
  type MovementType,
  type StockMovement,
  type StockStatus
} from '../../../core/models/inventory';

type ViewState = 'loading' | 'ready' | 'error';
type Notice = { text: string; kind: 'ok' | 'err' };
type StatusFilter = 'all' | StockStatus;
type OpType = 'entry' | 'adjustment' | 'return';
type Tab = 'stock' | 'movements';

/**
 * Módulo de inventario. Sirve tanto a `/admin/inventory` como a
 * `/employee/inventory` (la ruta del empleado reutiliza este componente).
 *
 * - Empleado: solo lectura. No ve pestaña de movimientos ni acciones.
 * - Admin: entrada / ajuste / devolución + historial.
 *
 * Ninguna operación toca `inventory` directamente: todas llaman a una RPC de
 * Postgres a través de `InventoryApi`. Ocultar botones es UX; la seguridad la
 * imponen el roleGuard, la RLS y el `is_admin()` dentro de cada RPC.
 */
@Component({
  selector: 'app-inventory',
  imports: [DatePipe, ReactiveFormsModule, Modal, Loading, Empty, Icon],
  templateUrl: './inventory.html',
  styleUrl: './inventory.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Inventory {

  private readonly api = inject(InventoryApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly auth = inject(Auth);

  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private movementsLoaded = false;

  protected readonly isAdmin = this.auth.isAdmin;

  // --- listado ---
  readonly state = signal<ViewState>('loading');
  readonly rows = signal<InventoryRow[]>([]);
  readonly search = signal('');
  readonly categoryFilter = signal<'all' | string>('all');
  readonly statusFilter = signal<StatusFilter>('all');
  readonly notice = signal<Notice | null>(null);
  readonly tab = signal<Tab>('stock');

  readonly categoryOptions = computed(() => {
    const seen = new Map<number, string>();
    for (const row of this.rows()) {
      if (row.categoryId != null && row.categoryName) {
        seen.set(row.categoryId, row.categoryName);
      }
    }
    return [...seen]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const category = this.categoryFilter();
    const status = this.statusFilter();
    return this.rows().filter((row) => {
      if (q && !row.productName.toLowerCase().includes(q)) {
        return false;
      }
      if (category !== 'all' && row.categoryId !== Number(category)) {
        return false;
      }
      if (status !== 'all' && row.status !== status) {
        return false;
      }
      return true;
    });
  });

  readonly counts = computed(() => {
    const rows = this.rows();
    return {
      total: rows.length,
      low: rows.filter((r) => r.status === 'low').length,
      out: rows.filter((r) => r.status === 'out').length
    };
  });

  // --- movimientos (admin) ---
  readonly movements = signal<StockMovement[]>([]);
  readonly movementsState = signal<ViewState>('loading');

  // --- modal de operación (admin) ---
  readonly opOpen = signal(false);
  readonly opType = signal<OpType>('entry');
  readonly opRow = signal<InventoryRow | null>(null);
  readonly opSaving = signal(false);
  readonly opError = signal('');
  readonly opForm = this.fb.group({
    amount: this.fb.control(0),
    reason: this.fb.control('')
  });
  private readonly opAmount = toSignal(this.opForm.controls.amount.valueChanges, {
    initialValue: 0 as number
  });

  readonly opTitle = computed(() => {
    switch (this.opType()) {
      case 'entry':
        return 'Registrar entrada';
      case 'adjustment':
        return 'Ajustar inventario';
      default:
        return 'Registrar devolución';
    }
  });

  readonly opPreview = computed(() => {
    const row = this.opRow();
    if (!row) {
      return null;
    }
    const current = row.quantity;
    const raw = Number(this.opAmount());
    const amount = Number.isFinite(raw) ? raw : 0;
    if (this.opType() === 'adjustment') {
      return { current, next: amount, delta: amount - current };
    }
    return { current, next: current + amount, delta: amount };
  });

  readonly reasonRequired = computed(() => this.opType() !== 'entry');

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.state.set('loading');
    try {
      this.rows.set(await this.api.list());
      this.state.set('ready');
    } catch (err) {
      console.error('[inventario] cargar:', err);
      this.state.set('error');
    }
  }

  selectTab(tab: Tab): void {
    this.tab.set(tab);
    if (tab === 'movements' && !this.movementsLoaded) {
      void this.loadMovements();
    }
  }

  async loadMovements(): Promise<void> {
    this.movementsState.set('loading');
    try {
      this.movements.set(await this.api.movements());
      this.movementsLoaded = true;
      this.movementsState.set('ready');
    } catch (err) {
      console.error('[inventario] movimientos:', err);
      this.movementsState.set('error');
    }
  }

  openOp(type: OpType, row: InventoryRow): void {
    this.opType.set(type);
    this.opRow.set(row);
    this.opError.set('');

    const amount = this.opForm.controls.amount;
    const reason = this.opForm.controls.reason;

    amount.setValidators(
      type === 'adjustment'
        ? [Validators.required, Validators.min(0), integerValidator]
        : [Validators.required, positiveIntValidator]
    );
    reason.setValidators(
      type === 'entry'
        ? [Validators.maxLength(300)]
        : [Validators.required, Validators.maxLength(300)]
    );

    this.opForm.reset({
      amount: type === 'adjustment' ? row.quantity : 0,
      reason: ''
    });
    amount.updateValueAndValidity();
    reason.updateValueAndValidity();

    this.opOpen.set(true);
  }

  closeOp(): void {
    if (!this.opSaving()) {
      this.opOpen.set(false);
    }
  }

  async submitOp(): Promise<void> {
    this.opError.set('');
    const row = this.opRow();
    if (!row || this.opForm.invalid || this.opSaving()) {
      this.opForm.markAllAsTouched();
      return;
    }

    const { amount, reason } = this.opForm.getRawValue();
    const type = this.opType();
    this.opSaving.set(true);
    try {
      const result =
        type === 'entry'
          ? await this.api.registerEntry(row.productId, amount, reason)
          : type === 'adjustment'
            ? await this.api.adjust(row.productId, amount, reason)
            : await this.api.registerReturn(row.productId, amount, reason);

      this.rows.update((list) =>
        list.map((r) =>
          r.productId === row.productId
            ? {
                ...r,
                quantity: result.newQuantity,
                status: stockStatus(result.newQuantity, r.minimumStock),
                updatedAt: new Date().toISOString()
              }
            : r
        )
      );

      this.movementsLoaded = false;
      if (this.tab() === 'movements') {
        void this.loadMovements();
      }

      const label =
        type === 'entry'
          ? 'Entrada registrada'
          : type === 'adjustment'
            ? 'Ajuste aplicado'
            : 'Devolución registrada';
      this.flash(
        `${label}. Stock: ${result.previousQuantity} → ${result.newQuantity}.`,
        'ok'
      );
      this.opOpen.set(false);
    } catch (err) {
      const dbError = err as DbError;
      console.error('[inventario] operación:', dbError);
      this.opError.set(friendlyInventoryError(dbError));
    } finally {
      this.opSaving.set(false);
    }
  }

  dismissNotice(): void {
    this.notice.set(null);
  }

  // ------------------------------------------------------------- etiquetas ---

  statusLabel(status: StockStatus): string {
    return status === 'out' ? 'Sin stock' : status === 'low' ? 'Stock bajo' : 'Normal';
  }
  statusClass(status: StockStatus): string {
    return status === 'out'
      ? 'badge--danger'
      : status === 'low'
        ? 'badge--warn'
        : 'badge--success';
  }
  movementLabel(type: MovementType): string {
    switch (type) {
      case 'entry':
        return 'Entrada';
      case 'sale':
        return 'Venta';
      case 'adjustment':
        return 'Ajuste';
      default:
        return 'Devolución';
    }
  }
  movementClass(type: MovementType): string {
    switch (type) {
      case 'entry':
        return 'badge--success';
      case 'sale':
        return 'badge--neutral';
      case 'adjustment':
        return 'badge--warn';
      default:
        return 'badge--neutral';
    }
  }

  private flash(text: string, kind: Notice['kind']): void {
    this.notice.set({ text, kind });
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = setTimeout(() => this.notice.set(null), 4500);
  }
}

function integerValidator(control: AbstractControl): ValidationErrors | null {
  return Number.isInteger(Number(control.value)) ? null : { integer: true };
}

function positiveIntValidator(control: AbstractControl): ValidationErrors | null {
  const n = Number(control.value);
  return Number.isInteger(n) && n > 0 ? null : { positiveInt: true };
}

function friendlyInventoryError(error: DbError): string {
  const message = (error.message ?? '').toUpperCase();
  if (message.includes('NOT_ADMIN') || error.code === '42501') {
    return 'No tienes permisos para modificar el inventario.';
  }
  if (message.includes('AUTH_REQUIRED')) {
    return 'Tu sesión expiró. Vuelve a iniciar sesión.';
  }
  if (message.includes('PRODUCT_NOT_FOUND') || message.includes('NO_INVENTORY_ROW')) {
    return 'El producto no tiene inventario registrado.';
  }
  if (message.includes('INVALID_QUANTITY')) {
    return 'La cantidad indicada no es válida.';
  }
  if (message.includes('REASON_REQUIRED')) {
    return 'El motivo es obligatorio para esta operación.';
  }
  if (message.includes('NEGATIVE_STOCK')) {
    return 'La operación dejaría el stock por debajo de cero.';
  }
  return humanizeDbError(error, 'No fue posible completar la operación de inventario.');
}
