import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Auth } from '../../../core/services/auth';
import { Sales } from '../../../core/services/sales';
import { Inventory } from '../../../core/services/inventory';
import { Realtime } from '../../../core/services/realtime';
import { CurrencyPipe } from '../../../shared/pipes/currency-pipe';
import { Loading } from '../../../shared/components/loading/loading';
import { Empty } from '../../../shared/components/empty/empty';
import type { PaymentStatus, RecentSale } from '../../../core/models/sale';
import type { InventoryItem, StockStatus } from '../../../core/models/inventory';

type LoadState = 'loading' | 'ready' | 'error';

/**
 * Dashboard del administrador. Todos los números salen de Supabase (servicios
 * `Sales` e `Inventory`). Si una consulta falla, esa sección muestra su propio
 * estado de error sin tumbar el resto del panel.
 */
@Component({
  selector: 'app-admin-dashboard',
  imports: [DatePipe, CurrencyPipe, Loading, Empty],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Dashboard {

  private readonly sales = inject(Sales);
  private readonly inventory = inject(Inventory);
  private readonly realtime = inject(Realtime);
  protected readonly auth = inject(Auth);

  protected readonly statsState = signal<LoadState>('loading');
  protected readonly recentState = signal<LoadState>('loading');
  protected readonly lowState = signal<LoadState>('loading');

  protected readonly todayTotal = signal(0);
  protected readonly todayCount = signal(0);
  protected readonly monthTotal = signal(0);
  protected readonly outstanding = signal(0);

  protected readonly recent = signal<RecentSale[]>([]);
  protected readonly lowStock = signal<InventoryItem[]>([]);
  protected readonly lowStockTop = computed(() => this.lowStock().slice(0, 6));

  constructor() {
    this.reload();

    // Una venta hecha en OTRO dispositivo (u otro empleado) recarga este
    // panel sola, sin que nadie tenga que refrescar. Se ignora el primer
    // disparo del effect (ya se cargó arriba) para no duplicar la carga inicial.
    let first = true;
    effect(() => {
      this.realtime.salesTick();
      this.realtime.inventoryTick();
      if (first) {
        first = false;
        return;
      }
      this.reload();
    });
  }

  reload(): void {
    void this.loadStats();
    void this.loadRecent();
    void this.loadLowStock();
  }

  private async loadStats(): Promise<void> {
    // Si ya había datos en pantalla (recarga en vivo), no se vuelve a mostrar
    // el spinner: solo se reemplazan los números cuando lleguen.
    if (this.statsState() !== 'ready') {
      this.statsState.set('loading');
    }
    const { startOfToday, startOfMonth, outstandingFrom } = timeWindow();
    try {
      const [today, month, pending] = await Promise.all([
        this.sales.summarySince(startOfToday),
        this.sales.summarySince(startOfMonth),
        this.sales.outstandingSince(outstandingFrom)
      ]);
      this.todayTotal.set(today.total);
      this.todayCount.set(today.count);
      this.monthTotal.set(month.total);
      this.outstanding.set(pending);
      this.statsState.set('ready');
    } catch (err) {
      console.error('[dashboard-admin] estadísticas:', err);
      this.statsState.set('error');
    }
  }

  private async loadRecent(): Promise<void> {
    if (this.recentState() !== 'ready') {
      this.recentState.set('loading');
    }
    try {
      this.recent.set(await this.sales.recent(4));
      this.recentState.set('ready');
    } catch (err) {
      console.error('[dashboard-admin] ventas recientes:', err);
      this.recentState.set('error');
    }
  }

  private async loadLowStock(): Promise<void> {
    if (this.lowState() !== 'ready') {
      this.lowState.set('loading');
    }
    try {
      this.lowStock.set(await this.inventory.lowStock());
      this.lowState.set('ready');
    } catch (err) {
      console.error('[dashboard-admin] stock bajo:', err);
      this.lowState.set('error');
    }
  }

  protected statusLabel(s: PaymentStatus): string {
    return s === 'paid' ? 'Pagada' : 'Abono parcial';
  }
  protected statusClass(s: PaymentStatus): string {
    return s === 'paid' ? 'badge--success' : 'badge--warn';
  }
  protected stockLabel(s: StockStatus): string {
    return s === 'out' ? 'Agotado' : 'Bajo';
  }
  protected stockClass(s: StockStatus): string {
    return s === 'out' ? 'badge--danger' : 'badge--warn';
  }
}

/** Marcas de tiempo (ISO) usadas por el dashboard, en hora local. */
function timeWindow(): {
  startOfToday: string;
  startOfMonth: string;
  outstandingFrom: string;
} {
  const now = new Date();
  return {
    startOfToday: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
    startOfMonth: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    // Ventana acotada para el pendiente por cobrar (ver Sales.outstandingSince).
    outstandingFrom: new Date(now.getFullYear(), now.getMonth() - 4, 1).toISOString()
  };
}
