import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Auth } from '../../../core/services/auth';
import { Sales as SalesApi } from '../../../core/services/sales';
import { humanizeDbError, type DbError } from '../../../core/services/supabase';
import { CurrencyPipe } from '../../../shared/pipes/currency-pipe';
import { Modal } from '../../../shared/components/modal/modal';
import { Loading } from '../../../shared/components/loading/loading';
import { Empty } from '../../../shared/components/empty/empty';
import {
  PAYMENT_METHODS,
  paymentMethodLabel,
  type PaymentMethod
} from '../../../core/models/payment';
import type { PendingSaleRow } from '../../../core/models/sale';

type ViewState = 'loading' | 'ready' | 'error';
type Notice = { text: string; kind: 'ok' | 'err' };

/**
 * "Abonar" (empleado): ventas propias que todavía tienen saldo pendiente,
 * sin importar el día en que se registraron. Un abono llama a la RPC
 * `add_payment`, que valida que la venta sea del empleado (o admin), que
 * el monto no exceda el pendiente y descuenta `customers.cuenta`. En una
 * sola transacción; Angular nunca toca `payments`/`customers` directo.
 */
@Component({
  selector: 'app-pending',
  imports: [DatePipe, CurrencyPipe, Modal, Loading, Empty],
  templateUrl: './pending.html',
  styleUrl: './pending.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Pending {

  private readonly api = inject(SalesApi);
  private readonly auth = inject(Auth);

  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly methods = PAYMENT_METHODS;
  protected readonly methodLabel = paymentMethodLabel;

  readonly state = signal<ViewState>('loading');
  readonly rows = signal<PendingSaleRow[]>([]);
  readonly search = signal('');
  readonly notice = signal<Notice | null>(null);

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) {
      return this.rows();
    }
    return this.rows().filter(
      (r) =>
        String(r.invoiceNumber ?? '').includes(q) ||
        (r.customerName ?? '').toLowerCase().includes(q)
    );
  });

  readonly totals = computed(() => {
    const rows = this.rows();
    return {
      count: rows.length,
      pending: rows.reduce((a, r) => a + r.pending, 0)
    };
  });

  // --- abonar (modal) ---
  readonly target = signal<PendingSaleRow | null>(null);
  readonly method = signal<PaymentMethod>('cash');
  readonly amount = signal(0);
  readonly saving = signal(false);
  readonly formError = signal('');

  readonly amountInvalid = computed(() => {
    const t = this.target();
    if (!t) {
      return false;
    }
    const a = this.amount();
    return !(a > 0 && a <= t.pending);
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.state.set('loading');
    try {
      const userId = this.auth.session()?.user.id;
      if (!userId) {
        throw new Error('AUTH_REQUIRED');
      }
      this.rows.set(await this.api.myPending(userId));
      this.state.set('ready');
    } catch (err) {
      console.error('[abonos] cargar:', err);
      this.state.set('error');
    }
  }

  openAbonar(row: PendingSaleRow): void {
    this.target.set(row);
    this.method.set('cash');
    this.amount.set(row.pending);
    this.formError.set('');
  }

  closeAbonar(): void {
    if (!this.saving()) {
      this.target.set(null);
    }
  }

  setMethod(value: string): void {
    this.method.set(value as PaymentMethod);
  }

  onAmount(value: string): void {
    const n = Number(value);
    this.amount.set(Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
  }

  async submit(): Promise<void> {
    const row = this.target();
    this.formError.set('');
    if (!row || this.amountInvalid() || this.saving()) {
      return;
    }

    this.saving.set(true);
    try {
      const result = await this.api.addPayment({
        saleId: row.id,
        method: this.method(),
        amount: this.amount()
      });
      this.target.set(null);
      this.rows.update((list) =>
        result.pending > 0
          ? list.map((r) =>
              r.id === row.id ? { ...r, paid: result.totalPaid, pending: result.pending } : r
            )
          : list.filter((r) => r.id !== row.id)
      );
      this.flash(
        row.invoiceNumber
          ? `Abono registrado a la factura #${row.invoiceNumber}.`
          : 'Abono registrado.',
        'ok'
      );
    } catch (err) {
      console.error('[abonos] registrar:', err);
      this.formError.set(this.friendlyError(err));
    } finally {
      this.saving.set(false);
    }
  }

  dismissNotice(): void {
    this.notice.set(null);
  }

  private friendlyError(err: unknown): string {
    const message = ((err as DbError)?.message ?? '').toUpperCase();
    if (message.includes('AUTH_REQUIRED')) {
      return 'Tu sesión expiró. Vuelve a iniciar sesión.';
    }
    if (message.includes('SALE_NOT_FOUND')) {
      return 'Esa venta ya no existe.';
    }
    if (message.includes('NOT_ALLOWED')) {
      return 'Esa venta no es tuya: no puedes abonarle.';
    }
    if (message.includes('NOTHING_PENDING')) {
      return 'Esa venta ya no tiene saldo pendiente.';
    }
    if (message.includes('PAYMENT_EXCEEDS_PENDING')) {
      return 'El monto no puede superar el saldo pendiente.';
    }
    if (message.includes('INVALID_PAYMENT')) {
      return 'El monto no es válido.';
    }
    if (message.includes('INVALID_METHOD')) {
      return 'El método de pago no es válido.';
    }
    if (message.includes('NO_CUSTOMER')) {
      return 'Esa venta no tiene cliente asignado.';
    }
    return humanizeDbError(err as DbError, 'No fue posible registrar el abono.');
  }

  private flash(text: string, kind: Notice['kind']): void {
    this.notice.set({ text, kind });
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = setTimeout(() => this.notice.set(null), 4500);
  }
}
