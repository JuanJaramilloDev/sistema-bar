import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Sales as SalesApi } from '../../../core/services/sales';
import { CurrencyPipe } from '../../../shared/pipes/currency-pipe';
import { Loading } from '../../../shared/components/loading/loading';
import { Empty } from '../../../shared/components/empty/empty';
import { paymentMethodLabel } from '../../../core/models/payment';
import type { AbonoRow, SalesRange } from '../../../core/models/sale';

type ViewState = 'loading' | 'ready' | 'error';

/**
 * Historial de abonos (solo admin). Un "abono" es cualquier pago que NO fue
 * el primero de su venta (el primero se registra al crear la venta; los
 * siguientes son abonos posteriores que un empleado o el admin agregan desde
 * "Abonar"/editar venta). Solo lectura: acá no se registran abonos.
 */
@Component({
  selector: 'app-admin-abonos',
  imports: [DatePipe, CurrencyPipe, Loading, Empty],
  templateUrl: './abonos.html',
  styleUrl: './abonos.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Abonos {

  private readonly api = inject(SalesApi);

  protected readonly methodLabel = paymentMethodLabel;

  readonly state = signal<ViewState>('loading');
  readonly rows = signal<AbonoRow[]>([]);
  readonly range = signal<SalesRange>('week');
  readonly search = signal('');

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) {
      return this.rows();
    }
    return this.rows().filter(
      (r) =>
        String(r.invoiceNumber ?? '').includes(q) ||
        (r.customerName ?? '').toLowerCase().includes(q) ||
        (r.employeeName ?? '').toLowerCase().includes(q)
    );
  });

  readonly totals = computed(() => {
    const rows = this.rows();
    return {
      count: rows.length,
      amount: rows.reduce((a, r) => a + r.amount, 0),
      cash: rows.filter((r) => r.method === 'cash').reduce((a, r) => a + r.amount, 0),
      transfer: rows.filter((r) => r.method === 'transfer').reduce((a, r) => a + r.amount, 0),
      card: rows.filter((r) => r.method === 'card').reduce((a, r) => a + r.amount, 0)
    };
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.state.set('loading');
    try {
      this.rows.set(await this.api.abonosHistory(this.range(), ''));
      this.state.set('ready');
    } catch (err) {
      console.error('[abonos-admin] cargar:', err);
      this.state.set('error');
    }
  }

  setRange(range: SalesRange): void {
    if (range === this.range()) {
      return;
    }
    this.range.set(range);
    void this.load();
  }
}
