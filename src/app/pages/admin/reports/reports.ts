import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe } from '../../../shared/pipes/currency-pipe';
import { DatePipe } from '@angular/common';
import { Loading } from '../../../shared/components/loading/loading';
import { Empty } from '../../../shared/components/empty/empty';
import { Icon } from '../../../shared/components/icon/icon';
import { Modal } from '../../../shared/components/modal/modal';
import {
  Reports as ReportsApi,
  type ReportGroupBy,
  type ReportSummary
} from '../../../core/services/reports';
import { Sales as SalesApi } from '../../../core/services/sales';
import { humanizeDbError, type DbError } from '../../../core/services/supabase';

type ViewState = 'loading' | 'ready' | 'error';
type RangePreset = 'week' | 'month' | 'quarter' | 'year' | 'custom';
type Notice = { text: string; kind: 'ok' | 'err' };

/** Palabra exacta que hay que escribir para habilitar el borrado total. */
const WIPE_CONFIRM_WORD = 'BORRAR';

/**
 * Reportes (solo admin). Todo se calcula sobre `sales`/`sale_items`/
 * `payments`/`customers` vía `core/services/reports.ts`. Vista de solo
 * lectura: acá no se registra nada, solo se consulta y se exporta.
 *
 * Exportar:
 *  - CSV (se abre directo en Excel): ventas por día/mes + top productos +
 *    ranking de empleados del periodo elegido. Sin librerías nuevas.
 *  - PDF: usa el diálogo de impresión del navegador ("Guardar como PDF"),
 *    con una hoja de estilos de impresión que oculta el menú y dejan solo
 *    el reporte. Tampoco necesita librerías nuevas.
 *
 * Zona de peligro: borra todo el historial de ventas/abonos (RPC
 * `wipe_sales_data`, ver `core/services/sales.ts`). Doble verificación en el
 * modal (casilla + escribir "BORRAR") para que no se dispare por accidente.
 */
@Component({
  selector: 'app-reports',
  imports: [CurrencyPipe, DatePipe, Loading, Empty, Icon, Modal],
  templateUrl: './reports.html',
  styleUrl: './reports.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Reports {

  private readonly api = inject(ReportsApi);
  private readonly salesApi = inject(SalesApi);
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  readonly state = signal<ViewState>('loading');
  readonly summary = signal<ReportSummary | null>(null);

  readonly preset = signal<RangePreset>('month');
  readonly groupBy = signal<ReportGroupBy>('day');
  readonly customFrom = signal('');
  readonly customTo = signal('');

  readonly rangeLabel = computed(() => {
    switch (this.preset()) {
      case 'week': return 'Últimos 7 días';
      case 'month': return 'Últimos 30 días';
      case 'quarter': return 'Últimos 90 días';
      case 'year': return 'Último año';
      default: return `${this.customFrom() || '…'} a ${this.customTo() || '…'}`;
    }
  });

  readonly maxPeriodTotal = computed(() =>
    Math.max(1, ...this.summary()?.byPeriod.map((p) => p.total) ?? [1])
  );

  readonly methodTotal = computed(() => {
    const m = this.summary()?.byMethod;
    return m ? m.cash + m.transfer + m.card : 0;
  });

  readonly bestPeriodLabel = computed(() => (this.groupBy() === 'day' ? 'Mejor día' : 'Mejor mes'));

  readonly notice = signal<Notice | null>(null);

  // --- Zona de peligro: borrar historial de ventas ---
  readonly wipeOpen = signal(false);
  readonly wipeAck = signal(false);
  readonly wipeConfirmText = signal('');
  readonly wiping = signal(false);
  readonly wipeError = signal('');
  readonly wipeReady = computed(
    () => this.wipeAck() && this.wipeConfirmText().trim().toUpperCase() === WIPE_CONFIRM_WORD
  );

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.state.set('loading');
    try {
      const { fromIso, toIso } = this.effectiveRange();
      this.summary.set(await this.api.summary(fromIso, toIso, this.groupBy()));
      this.state.set('ready');
    } catch (err) {
      console.error('[reportes] cargar:', err);
      this.state.set('error');
    }
  }

  /** `{fromIso, toIso}` (toIso exclusivo) según el preset o el rango personalizado. */
  private effectiveRange(): { fromIso: string; toIso: string } {
    return rangeFromPreset(this.preset(), this.customFrom(), this.customTo());
  }

  setPreset(preset: RangePreset): void {
    if (preset === this.preset()) {
      return;
    }
    this.preset.set(preset);
    void this.load();
  }

  setGroupBy(groupBy: ReportGroupBy): void {
    if (groupBy === this.groupBy()) {
      return;
    }
    this.groupBy.set(groupBy);
    void this.load();
  }

  applyCustomRange(): void {
    if (!this.customFrom() || !this.customTo()) {
      return;
    }
    this.preset.set('custom');
    void this.load();
  }

  /** Porcentaje (0–100) de un método sobre el total cobrado, para la barra. */
  methodPct(amount: number): number {
    const total = this.methodTotal();
    return total > 0 ? Math.round((amount / total) * 100) : 0;
  }

  barHeightPct(total: number): number {
    return Math.max(2, Math.round((total / this.maxPeriodTotal()) * 100));
  }

  exportPdf(): void {
    window.print();
  }

  exportCsv(): void {
    const s = this.summary();
    if (!s) {
      return;
    }
    const lines: string[] = [];
    lines.push(`Reporte de ventas;${this.rangeLabel()}`);
    lines.push('');

    lines.push(this.groupBy() === 'day' ? 'Ventas por día' : 'Ventas por mes');
    lines.push(csvRow(['Periodo', 'N° ventas', 'Total', 'Pendiente']));
    for (const p of s.byPeriod) {
      lines.push(csvRow([p.label, p.count, p.total, p.pending]));
    }
    lines.push('');

    lines.push('Productos más vendidos');
    lines.push(csvRow(['Producto', 'Cantidad', 'Total']));
    for (const p of s.topProducts) {
      lines.push(csvRow([p.name, p.quantity, p.total]));
    }
    lines.push('');

    lines.push('Ventas por empleado');
    lines.push(csvRow(['Empleado', 'N° ventas', 'Total']));
    for (const e of s.byEmployee) {
      lines.push(csvRow([e.name, e.count, e.total]));
    }
    lines.push('');

    lines.push('Detalle de ventas');
    lines.push(csvRow(['Fecha', 'Factura', 'Producto', 'Cantidad', 'Total']));
    for (const d of s.detail) {
      lines.push(
        csvRow([formatDate(d.createdAt), d.invoiceNumber ? '#' + d.invoiceNumber : '—', d.productName, d.quantity, d.total])
      );
    }

    downloadCsv(`reporte-ventas_${fileDate()}.csv`, lines.join('\n'));
  }

  // ----------------------------------------------------- zona de peligro ---

  openWipe(): void {
    this.wipeOpen.set(true);
    this.wipeAck.set(false);
    this.wipeConfirmText.set('');
    this.wipeError.set('');
  }

  closeWipe(): void {
    if (!this.wiping()) {
      this.wipeOpen.set(false);
    }
  }

  async confirmWipe(): Promise<void> {
    if (!this.wipeReady() || this.wiping()) {
      return;
    }
    this.wiping.set(true);
    this.wipeError.set('');
    try {
      const result = await this.salesApi.wipeAll();
      this.wipeOpen.set(false);
      this.flash(
        `Historial borrado: ${result.salesDeleted} venta(s) y ${result.paymentsDeleted} pago(s)/abono(s).`,
        'ok'
      );
      void this.load();
    } catch (err) {
      console.error('[reportes] borrar historial:', err);
      this.wipeError.set(humanizeDbError(err as DbError, 'No fue posible borrar el historial.'));
    } finally {
      this.wiping.set(false);
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
    this.noticeTimer = setTimeout(() => this.notice.set(null), 6000);
  }
}

function csvRow(values: (string | number)[]): string {
  return values
    .map((v) => {
      const s = String(v ?? '');
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(';');
}

function downloadCsv(filename: string, content: string): void {
  const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatDate(iso: string): string {
  if (!iso) {
    return '—';
  }
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fileDate(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** `{fromIso, toIso}` (toIso exclusivo) según el preset o el rango personalizado. */
function rangeFromPreset(preset: RangePreset, customFrom: string, customTo: string): { fromIso: string; toIso: string } {
  const now = new Date();
  const toIso = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  switch (preset) {
    case 'week':
      return { fromIso: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), toIso };
    case 'month':
      return { fromIso: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), toIso };
    case 'quarter':
      return { fromIso: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(), toIso };
    case 'year':
      return { fromIso: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString(), toIso };
    case 'custom': {
      const from = customFrom ? new Date(customFrom + 'T00:00:00') : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const to = customTo ? new Date(customTo + 'T00:00:00') : now;
      to.setDate(to.getDate() + 1);
      return { fromIso: from.toISOString(), toIso: to.toISOString() };
    }
  }
}

