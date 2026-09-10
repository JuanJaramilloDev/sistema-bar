import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Auth } from '../../../core/services/auth';
import { Sales } from '../../../core/services/sales';
import { Inventory } from '../../../core/services/inventory';
import { CurrencyPipe } from '../../../shared/pipes/currency-pipe';
import { Loading } from '../../../shared/components/loading/loading';
import { Empty } from '../../../shared/components/empty/empty';
import type { RecentSale, SaleStatus } from '../../../core/models/sale';
import type { InventoryItem, StockStatus } from '../../../core/models/inventory';

type LoadState = 'loading' | 'ready' | 'error';

/**
 * Dashboard del empleado. Solo muestra información que le corresponde: las
 * ventas propias y el inventario (consulta). El alcance de "propias" lo aplica
 * la RLS de Supabase sobre la tabla `sales`.
 */
@Component({
  selector: 'app-employee-dashboard',
  imports: [DatePipe, CurrencyPipe, Loading, Empty],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Dashboard {

  private readonly sales = inject(Sales);
  private readonly inventory = inject(Inventory);
  protected readonly auth = inject(Auth);

  protected readonly statsState = signal<LoadState>('loading');
  protected readonly recentState = signal<LoadState>('loading');
  protected readonly lowState = signal<LoadState>('loading');

  protected readonly todayTotal = signal(0);
  protected readonly todayCount = signal(0);
  protected readonly outstanding = signal(0);

  protected readonly recent = signal<RecentSale[]>([]);
  protected readonly lowStock = signal<InventoryItem[]>([]);
  protected readonly lowStockTop = computed(() => this.lowStock().slice(0, 6));

  constructor() {
    this.reload();
  }

  reload(): void {
    void this.loadStats();
    void this.loadRecent();
    void this.loadLowStock();
  }

  private async loadStats(): Promise<void> {
    this.statsState.set('loading');
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).toISOString();
    const outstandingFrom = new Date(
      now.getFullYear(),
      now.getMonth() - 4,
      1
    ).toISOString();
    try {
      const [today, pending] = await Promise.all([
        this.sales.summarySince(startOfToday),
        this.sales.outstandingSince(outstandingFrom)
      ]);
      this.todayTotal.set(today.total);
      this.todayCount.set(today.count);
      this.outstanding.set(pending);
      this.statsState.set('ready');
    } catch (err) {
      console.error('[dashboard-employee] estadísticas:', err);
      this.statsState.set('error');
    }
  }

  private async loadRecent(): Promise<void> {
    this.recentState.set('loading');
    try {
      this.recent.set(await this.sales.recent(6));
      this.recentState.set('ready');
    } catch (err) {
      console.error('[dashboard-employee] ventas recientes:', err);
      this.recentState.set('error');
    }
  }

  private async loadLowStock(): Promise<void> {
    this.lowState.set('loading');
    try {
      this.lowStock.set(await this.inventory.lowStock());
      this.lowState.set('ready');
    } catch (err) {
      console.error('[dashboard-employee] stock bajo:', err);
      this.lowState.set('error');
    }
  }

  protected statusLabel(s: SaleStatus): string {
    return s === 'paid' ? 'Pagada' : s === 'partial' ? 'Parcial' : 'Pendiente';
  }
  protected statusClass(s: SaleStatus): string {
    return s === 'paid' ? 'badge--success' : s === 'partial' ? 'badge--warn' : 'badge--danger';
  }
  protected stockLabel(s: StockStatus): string {
    return s === 'out' ? 'Agotado' : 'Bajo';
  }
  protected stockClass(s: StockStatus): string {
    return s === 'out' ? 'badge--danger' : 'badge--warn';
  }
}
