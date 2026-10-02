import { Injectable, inject } from '@angular/core';
import { Supabase } from './supabase';
import type { PaymentMethod } from '../models/payment';

/** Agrupación de los reportes de ventas: por día o por mes. */
export type ReportGroupBy = 'day' | 'month';

/** Una fila de ventas agrupada por día o por mes. */
export interface ReportPeriodRow {
  /** '2026-09-15' (día) o '2026-09' (mes). Sirve para ordenar. */
  key: string;
  /** Etiqueta legible: '15 sep' o 'sep 2026'. */
  label: string;
  count: number;
  total: number;
  pending: number;
}

export interface ReportProductRow {
  productId: number;
  name: string;
  quantity: number;
  total: number;
}

export interface ReportEmployeeRow {
  employeeId: string;
  name: string;
  count: number;
  total: number;
}

export interface ReportMethodTotals {
  cash: number;
  transfer: number;
  card: number;
}

/** Una línea vendida: venta (factura), producto, cantidad, total y fecha. */
export interface ReportSaleItemRow {
  saleId: string;
  invoiceNumber: number | null;
  createdAt: string;
  productName: string;
  quantity: number;
  total: number;
}

export interface ReportSummary {
  count: number;
  subtotal: number;
  discount: number;
  total: number;
  paid: number;
  pending: number;
  avgTicket: number;
  abonos: number;
  abonosCount: number;
  /** Deuda total actual de todos los clientes (no depende del rango elegido). */
  outstandingNow: number;
  byMethod: ReportMethodTotals;
  byPeriod: ReportPeriodRow[];
  topProducts: ReportProductRow[];
  byEmployee: ReportEmployeeRow[];
  bestPeriod: ReportPeriodRow | null;
  /** Detalle línea por línea del periodo (venta, producto, cantidad, total, fecha). */
  detail: ReportSaleItemRow[];
}

/**
 * Reportes administrativos (Fase 10). Todo se calcula en el cliente a partir
 * de `sales` / `sale_items` / `payments` / `customers` (la RLS de admin ya
 * permite ver todo). Para el volumen de un solo bar esto es suficiente; si
 * el volumen crece mucho, esto debería moverse a una vista/RPC en Supabase.
 */
@Injectable({ providedIn: 'root' })
export class Reports {

  private readonly supabase = inject(Supabase);

  private get db() {
    return this.supabase.getClient();
  }

  /**
   * Resumen completo de ventas entre `fromIso` (incluido) y `toIso`
   * (excluido). `groupBy` decide si `byPeriod` viene por día o por mes.
   */
  async summary(fromIso: string, toIso: string, groupBy: ReportGroupBy): Promise<ReportSummary> {
    const outstandingNow = await this.outstandingNow();

    const { data: salesData, error: salesErr } = await this.db
      .from('sales')
      .select('id, invoice_number, subtotal, discount, total, user_id, customer_id, created_at')
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .neq('status', 'cancelled')
      .returns<
        {
          id: string;
          invoice_number: number | null;
          subtotal: number | null;
          discount: number | null;
          total: number | null;
          user_id: string | null;
          customer_id: number | null;
          created_at: string;
        }[]
      >();
    if (salesErr) {
      throw salesErr;
    }
    const sales = salesData ?? [];

    if (sales.length === 0) {
      return emptySummary(outstandingNow);
    }

    const saleIds = sales.map((s) => s.id);

    const [paymentsRes, itemsRes] = await Promise.all([
      this.db
        .from('payments')
        .select('id, sale_id, payment_method, amount, created_at')
        .in('sale_id', saleIds)
        .returns<{ id: number; sale_id: string; payment_method: PaymentMethod; amount: number | null; created_at: string }[]>(),
      this.db
        .from('sale_items')
        .select('sale_id, product_id, quantity, subtotal')
        .in('sale_id', saleIds)
        .returns<{ sale_id: string; product_id: number; quantity: number | null; subtotal: number | null }[]>()
    ]);
    if (paymentsRes.error) throw paymentsRes.error;
    if (itemsRes.error) throw itemsRes.error;

    const payments = paymentsRes.data ?? [];
    const items = itemsRes.data ?? [];

    // --- pagado por venta + desglose por método (neto: los reembolsos de
    //     devoluciones son pagos negativos) + abonos. Los pagos iniciales (uno
    //     o varios métodos) comparten el `created_at` más antiguo de su venta;
    //     un abono es un pago positivo posterior. ---
    const paidBySale = new Map<string, number>();
    const firstAtBySale = new Map<string, number>();
    for (const p of payments) {
      const at = Date.parse(p.created_at);
      const current = firstAtBySale.get(p.sale_id);
      if (current === undefined || at < current) {
        firstAtBySale.set(p.sale_id, at);
      }
    }
    const byMethod: ReportMethodTotals = { cash: 0, transfer: 0, card: 0 };
    let abonos = 0;
    let abonosCount = 0;
    for (const p of payments) {
      const amount = p.amount ?? 0;
      paidBySale.set(p.sale_id, (paidBySale.get(p.sale_id) ?? 0) + amount);
      if (p.payment_method === 'cash') byMethod.cash += amount;
      else if (p.payment_method === 'card') byMethod.card += amount;
      else byMethod.transfer += amount;
      if (amount > 0 && Date.parse(p.created_at) > (firstAtBySale.get(p.sale_id) ?? Infinity)) {
        abonos += amount;
        abonosCount += 1;
      }
    }

    // --- top productos ---
    const productAgg = new Map<number, { qty: number; total: number }>();
    for (const it of items) {
      const cur = productAgg.get(it.product_id) ?? { qty: 0, total: 0 };
      cur.qty += it.quantity ?? 0;
      cur.total += it.subtotal ?? 0;
      productAgg.set(it.product_id, cur);
    }
    const productIds = [...productAgg.keys()];
    const productNames = await this.namesFrom('products', productIds);
    const topProducts: ReportProductRow[] = productIds
      .map((id) => {
        const agg = productAgg.get(id)!;
        return { productId: id, name: productNames.get(id) ?? 'Producto', quantity: agg.qty, total: agg.total };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    // --- detalle línea por línea (venta, producto, total, fecha): base del
    //     "Detalle de ventas" en pantalla y del recibo exportado a PDF/CSV ---
    const saleById = new Map(sales.map((s) => [s.id, s]));
    const detail: ReportSaleItemRow[] = items
      .map((it) => {
        const sale = saleById.get(it.sale_id);
        return {
          saleId: it.sale_id,
          invoiceNumber: sale?.invoice_number ?? null,
          createdAt: sale?.created_at ?? '',
          productName: productNames.get(it.product_id) ?? 'Producto',
          quantity: it.quantity ?? 0,
          total: it.subtotal ?? 0
        } satisfies ReportSaleItemRow;
      })
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || (a.invoiceNumber ?? 0) - (b.invoiceNumber ?? 0)
      );

    // --- ranking de empleados ---
    const employeeAgg = new Map<string, { count: number; total: number }>();
    for (const s of sales) {
      if (!s.user_id) continue;
      const cur = employeeAgg.get(s.user_id) ?? { count: 0, total: 0 };
      cur.count += 1;
      cur.total += s.total ?? 0;
      employeeAgg.set(s.user_id, cur);
    }
    const employeeNames = await this.namesFrom('profiles', [...employeeAgg.keys()]);
    const byEmployee: ReportEmployeeRow[] = [...employeeAgg.entries()]
      .map(([id, v]) => ({ employeeId: id, name: employeeNames.get(id) ?? '—', count: v.count, total: v.total }))
      .sort((a, b) => b.total - a.total);

    // --- ventas por día/mes ---
    const periodAgg = new Map<string, { count: number; total: number; pending: number }>();
    for (const s of sales) {
      const key = groupBy === 'day' ? dayKey(s.created_at) : monthKey(s.created_at);
      const cur = periodAgg.get(key) ?? { count: 0, total: 0, pending: 0 };
      const total = s.total ?? 0;
      const paid = paidBySale.get(s.id) ?? 0;
      cur.count += 1;
      cur.total += total;
      cur.pending += Math.max(0, total - paid);
      periodAgg.set(key, cur);
    }
    const byPeriod: ReportPeriodRow[] = [...periodAgg.entries()]
      .map(([key, v]) => ({
        key,
        label: groupBy === 'day' ? dayLabel(key) : monthLabel(key),
        count: v.count,
        total: v.total,
        pending: v.pending
      }))
      .sort((a, b) => a.key.localeCompare(b.key));

    const bestPeriod = byPeriod.reduce<ReportPeriodRow | null>(
      (best, cur) => (!best || cur.total > best.total ? cur : best),
      null
    );

    const subtotal = sales.reduce((a, s) => a + (s.subtotal ?? 0), 0);
    const discount = sales.reduce((a, s) => a + (s.discount ?? 0), 0);
    const total = sales.reduce((a, s) => a + (s.total ?? 0), 0);
    const paid = [...paidBySale.values()].reduce((a, v) => a + v, 0);
    const pending = Math.max(0, total - paid);

    return {
      count: sales.length,
      subtotal,
      discount,
      total,
      paid,
      pending,
      avgTicket: sales.length > 0 ? total / sales.length : 0,
      abonos,
      abonosCount,
      outstandingNow,
      byMethod,
      byPeriod,
      topProducts,
      byEmployee,
      bestPeriod,
      detail
    };
  }

  /** Deuda total actual de todos los clientes (independiente del rango). */
  private async outstandingNow(): Promise<number> {
    const { data, error } = await this.db
      .from('customers')
      .select('cuenta')
      .returns<{ cuenta: number | null }[]>();
    if (error) {
      throw error;
    }
    return (data ?? []).reduce((a, c) => a + (c.cuenta ?? 0), 0);
  }

  /** Diccionario id -> nombre para `profiles` o `products` (ambas tienen columna `name`). */
  private async namesFrom<T extends string | number>(
    table: 'profiles' | 'products',
    ids: T[]
  ): Promise<Map<T, string>> {
    const result = new Map<T, string>();
    if (ids.length === 0) {
      return result;
    }
    const { data, error } = await this.db
      .from(table)
      .select('id, name')
      .in('id', ids)
      .returns<{ id: T; name: string | null }[]>();
    if (error) {
      throw error;
    }
    for (const row of data ?? []) {
      result.set(row.id, row.name ?? '');
    }
    return result;
  }
}

function emptySummary(outstandingNow: number): ReportSummary {
  return {
    count: 0,
    subtotal: 0,
    discount: 0,
    total: 0,
    paid: 0,
    pending: 0,
    avgTicket: 0,
    abonos: 0,
    abonosCount: 0,
    outstandingNow,
    byMethod: { cash: 0, transfer: 0, card: 0 },
    byPeriod: [],
    topProducts: [],
    byEmployee: [],
    bestPeriod: null,
    detail: []
  };
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

const DAY_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function dayLabel(key: string): string {
  const [, m, d] = key.split('-');
  return `${Number(d)} ${DAY_MONTHS[Number(m) - 1]}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  return `${DAY_MONTHS[Number(m) - 1]} ${y}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
