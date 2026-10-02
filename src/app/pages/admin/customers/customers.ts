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
  NonNullableFormBuilder,
  ReactiveFormsModule,
  Validators
} from '@angular/forms';
import { Auth } from '../../../core/services/auth';
import { Customers as CustomersApi } from '../../../core/services/customers';
import { humanizeDbError, type DbError } from '../../../core/services/supabase';
import { CurrencyPipe } from '../../../shared/pipes/currency-pipe';
import { Modal } from '../../../shared/components/modal/modal';
import { Loading } from '../../../shared/components/loading/loading';
import { Empty } from '../../../shared/components/empty/empty';
import { Icon } from '../../../shared/components/icon/icon';
import type { Customer, CustomerInput } from '../../../core/models/customer';
import {
  PAYMENT_METHODS,
  paymentMethodLabel,
  type PaymentMethod
} from '../../../core/models/payment';

type ViewState = 'loading' | 'ready' | 'error';
type Notice = { text: string; kind: 'ok' | 'err' };

/**
 * Gestión de clientes. Sirve a `/admin/customers` y `/employee/customers`.
 * Ambos roles consultan y crean; solo el admin edita y elimina (además de
 * la RLS de Supabase, que es la barrera real). El empleado abona a sus
 * propias ventas pendientes desde "Abonar" (`pages/employee/pending`), no
 * desde aquí.
 *
 * `cuenta` = saldo pendiente. Al crear se fija el saldo inicial; al editar
 * (admin) se puede sumar un cargo (nuevo consumo) y/o registrar un abono.
 * El abono pasa por la RPC `pay_customer_debt`, que lo aplica como pago a
 * las ventas pendientes del cliente (no solo baja el número de la cuenta).
 */
@Component({
  selector: 'app-customers',
  imports: [DatePipe, ReactiveFormsModule, CurrencyPipe, Modal, Loading, Empty, Icon],
  templateUrl: './customers.html',
  styleUrl: './customers.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Customers {

  private readonly api = inject(CustomersApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly auth = inject(Auth);

  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly isAdmin = this.auth.isAdmin;

  readonly state = signal<ViewState>('loading');
  readonly all = signal<Customer[]>([]);
  readonly search = signal('');
  readonly notice = signal<Notice | null>(null);

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const list = this.all();
    if (!q) {
      return list;
    }
    return list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.phone ?? '').toLowerCase().includes(q)
    );
  });

  readonly totalPending = computed(() =>
    this.all().reduce((acc, c) => acc + (c.cuenta || 0), 0)
  );

  // --- formulario ---
  readonly formOpen = signal(false);
  readonly editing = signal<Customer | null>(null);
  readonly saving = signal(false);
  readonly formError = signal('');
  readonly form = this.fb.group({
    name: this.fb.control('', [Validators.required, Validators.maxLength(120)]),
    phone: this.fb.control('', [Validators.maxLength(40)]),
    notes: this.fb.control('', [Validators.maxLength(500)]),
    cuenta: this.fb.control(0, [Validators.min(0)]),
    cargo: this.fb.control(0, [Validators.min(0)]),
    abono: this.fb.control(0, [Validators.min(0)]),
    abonoMethod: this.fb.control<PaymentMethod>('cash')
  });

  protected readonly methods = PAYMENT_METHODS;
  protected readonly methodLabel = paymentMethodLabel;

  private readonly cargoValue = toSignal(this.form.controls.cargo.valueChanges, {
    initialValue: 0 as number
  });
  private readonly abonoValue = toSignal(this.form.controls.abono.valueChanges, {
    initialValue: 0 as number
  });

  /** Previsualización del efecto de cargo/abono en la cuenta (solo en edición). */
  readonly cuentaPreview = computed(() => {
    const customer = this.editing();
    if (!customer) {
      return null;
    }
    const cargo = positive(this.cargoValue());
    const abono = positive(this.abonoValue());
    const next = Math.max(0, customer.cuenta + cargo - abono);
    return {
      current: customer.cuenta,
      cargo,
      abono,
      next,
      delta: next - customer.cuenta,
      /** El abono no puede pasar de lo que se debe. */
      abonoTooHigh: abono > customer.cuenta + cargo
    };
  });

  // --- borrado (admin) ---
  readonly deleteTarget = signal<Customer | null>(null);
  readonly deleting = signal(false);
  readonly deleteError = signal('');

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.state.set('loading');
    try {
      this.all.set(await this.api.list());
      this.state.set('ready');
    } catch (err) {
      console.error('[clientes] cargar:', err);
      this.state.set('error');
    }
  }

  openCreate(): void {
    this.editing.set(null);
    this.formError.set('');
    this.form.reset({ name: '', phone: '', notes: '', cuenta: 0, cargo: 0, abono: 0, abonoMethod: 'cash' });
    this.formOpen.set(true);
  }

  openEdit(customer: Customer): void {
    this.editing.set(customer);
    this.formError.set('');
    this.form.reset({
      name: customer.name,
      phone: customer.phone ?? '',
      notes: customer.notes ?? '',
      cuenta: customer.cuenta,
      cargo: 0,
      abono: 0,
      abonoMethod: 'cash'
    });
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

    const raw = this.form.getRawValue();
    const editing = this.editing();
    this.saving.set(true);
    try {
      if (editing) {
        const cargo = positive(raw.cargo);
        const abono = positive(raw.abono);
        if (abono > editing.cuenta + cargo) {
          this.formError.set('El abono no puede ser mayor a lo que debe el cliente.');
          return;
        }
        // 1) datos + cargo; 2) el abono va por la RPC para que pague sus ventas.
        const input: CustomerInput = {
          name: raw.name,
          phone: raw.phone,
          notes: raw.notes,
          cuenta: editing.cuenta + cargo
        };
        let updated = await this.api.update(editing.id, input);
        if (abono > 0) {
          const cuenta = await this.api.payDebt(editing.id, raw.abonoMethod, abono);
          updated = { ...updated, cuenta };
        }
        const nextCuenta = updated.cuenta;
        this.all.update((list) =>
          [...list.map((c) => (c.id === updated.id ? updated : c))].sort(byName)
        );
        const moved = cargo > 0 || abono > 0;
        this.flash(
          moved
            ? `Cuenta actualizada: ${editing.cuenta} → ${nextCuenta}.`
            : 'Cliente actualizado.',
          'ok'
        );
      } else {
        const input: CustomerInput = {
          name: raw.name,
          phone: raw.phone,
          notes: raw.notes,
          cuenta: Number(raw.cuenta)
        };
        const created = await this.api.create(input);
        this.all.update((list) => [...list, created].sort(byName));
        this.flash('Cliente registrado correctamente.', 'ok');
      }
      this.formOpen.set(false);
    } catch (err) {
      const dbError = err as DbError;
      console.error('[clientes] guardar:', dbError);
      this.formError.set(
        /PAYMENT_EXCEEDS_PENDING/i.test(dbError.message ?? '')
          ? 'El abono no puede ser mayor a lo que debe el cliente.'
          : humanizeDbError(dbError, 'No fue posible guardar el cliente.')
      );
    } finally {
      this.saving.set(false);
    }
  }

  askDelete(customer: Customer): void {
    this.deleteError.set('');
    this.deleteTarget.set(customer);
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
      this.all.update((list) => list.filter((c) => c.id !== target.id));
      this.deleteTarget.set(null);
      this.flash('Cliente eliminado.', 'ok');
    } catch (err) {
      const dbError = err as DbError;
      console.error('[clientes] eliminar:', dbError);
      this.deleteError.set(
        dbError.code === '23503'
          ? 'No se puede eliminar: el cliente tiene ventas asociadas.'
          : humanizeDbError(dbError, 'No fue posible eliminar el cliente.')
      );
    } finally {
      this.deleting.set(false);
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

function byName(a: Customer, b: Customer): number {
  return a.name.localeCompare(b.name);
}

/** Convierte cualquier entrada del formulario a un entero ≥ 0. */
function positive(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
