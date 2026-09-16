import { Injectable, inject } from '@angular/core';
import { Supabase } from './supabase';
import type {
  CreateSaleInput,
  CreateSaleResult,
  RecentSale,
  SaleDetail,
  SaleListRow,
  SalesRange,
  SalesSummary,
  SaleStatus,
  UpdateSaleInput
} from '../models/sale';
import type { PaymentMethod } from '../models/payment';

/**
 * Acceso a las ventas.
 *
 * LECTURA: consultas normales. El alcance lo decide la RLS de Supabase:
 *   - employee -> solo sus ventas
 *   - admin    -> todas
 * Este servicio no filtra por empleado; confía en la política.
 *
 * ESCRITURA: registrar una venta NUNCA se hace con inserts sueltos desde
 * Angular. `create()` llama a la RPC `create_sale`, que en UNA transacción:
 * crea la venta + los `sale_items` (con copia del precio) + el pago inicial +
 * descuenta `inventory` + deja los `inventory_movements` + suma el pendiente a
 * la cuenta del cliente. Si algo falla, rollback completo.
 *
 * Columnas (ver también core/models/sale.ts):
 *   sales:    id (uuid), invoice_number, user_id (uuid, empleado), customer_id,
 *             subtotal, discount, total, status (enum sale_status), created_at
 *   payments: sale_id (uuid), method, amount
 *   nombre del empleado/cliente -> profiles.name / customers.name
 * Si tu esquema usa otros nombres, cámbialos SOLO aquí.
 */
@Injectable({ providedIn: 'root' })
export class Sales {

  private readonly supabase = inject(Supabase);

  private get db() {
    return this.supabase.getClient();
  }

  /**
   * Registra una venta completa vía RPC transaccional. Devuelve el resumen de
   * cobro (total / pagado / pendiente). Lanza el error de Postgres tal cual;
   * la página lo traduce por código.
   */
  async create(input: CreateSaleInput): Promise<CreateSaleResult> {
    const items = input.items
      .filter((i) => Number(i.quantity) > 0)
      .map((i) => ({
        product_id: Number(i.product_id),
        quantity: Math.trunc(Number(i.quantity)),
        unit_price: Number(i.unit_price)
      }));

    const hasPayment = !!input.payment && Number(input.payment.amount) > 0;

    const { data, error } = await this.db.rpc('create_sale', {
      p_customer_id: input.customerId ? Number(input.customerId) : null,
      p_discount: Math.max(0, Math.round(Number(input.discount) || 0)),
      p_items: items,
      p_method: hasPayment ? input.payment!.method : null,
      p_amount: hasPayment ? Math.round(Number(input.payment!.amount)) : 0
    });

    if (error) {
      throw error;
    }

    const r = (data ?? {}) as {
      sale_id?: string;
      invoice_number?: number | null;
      subtotal?: number;
      discount?: number;
      total?: number;
      paid?: number;
      pending?: number;
      status?: SaleStatus;
    };
    const total = Number(r.total ?? 0);
    const paid = Number(r.paid ?? 0);
    const pending = Number(r.pending ?? Math.max(0, total - paid));
    return {
      saleId: String(r.sale_id ?? ''),
      invoiceNumber: r.invoice_number ?? null,
      subtotal: Number(r.subtotal ?? 0),
      discount: Number(r.discount ?? 0),
      total,
      paid,
      pending,
      status: r.status ?? deriveStatus(total, paid)
    };
  }

  /**
   * Listado de ventas para el módulo Ventas / Facturas. El alcance (todas vs.
   * propias) lo impone la RLS. `range` acota por fecha para no escanear todo.
   */
  async list(range: SalesRange = 'week', search = ''): Promise<SaleListRow[]> {
    let query = this.db
      .from('sales')
      .select('id, invoice_number, subtotal, discount, total, status, customer_id, user_id, created_at')
      .order('created_at', { ascending: false })
      .limit(500);

    const from = rangeStartIso(range);
    if (from) {
      query = query.gte('created_at', from);
    }

    const { data, error } = await query.returns<
      {
        id: string;
        invoice_number: number | null;
        subtotal: number | null;
        discount: number | null;
        total: number | null;
        status: SaleStatus | null;
        customer_id: number | null;
        user_id: string | null;
        created_at: string;
      }[]
    >();

    if (error) {
      throw error;
    }

    const rows = data ?? [];
    if (rows.length === 0) {
      return [];
    }

    const [employees, customers, paidByMethod] = await Promise.all([
      this.namesFrom('profiles', unique(rows.map((r) => r.user_id))),
      this.namesFrom('customers', unique(rows.map((r) => r.customer_id))),
      this.paidByMethod(rows.map((r) => r.id))
    ]);

    const term = search.trim().toLowerCase();

    return rows
      .map((r) => {
        const total = r.total ?? 0;
        const bucket = paidByMethod.get(r.id) ?? { cash: 0, transfer: 0 };
        const paid = bucket.cash + bucket.transfer;
        return {
          id: r.id,
          invoiceNumber: r.invoice_number,
          subtotal: r.subtotal ?? total,
          discount: r.discount ?? 0,
          total,
          paidCash: bucket.cash,
          paidTransfer: bucket.transfer,
          paid,
          pending: Math.max(0, total - paid),
          status: r.status ?? deriveStatus(total, paid),
          customerId: r.customer_id,
          createdAt: r.created_at,
          employeeName: r.user_id ? employees.get(r.user_id) ?? null : null,
          customerName: r.customer_id ? customers.get(r.customer_id) ?? null : null
        } satisfies SaleListRow;
      })
      .filter((row) => {
        if (!term) {
          return true;
        }
        return (
          String(row.invoiceNumber ?? '').includes(term) ||
          (row.customerName ?? '').toLowerCase().includes(term) ||
          (row.employeeName ?? '').toLowerCase().includes(term)
        );
      });
  }

  /** Detalle de una venta: líneas (con nombre de producto) y pagos. */
  async detail(saleId: string): Promise<SaleDetail> {
    const [sale, items, payments] = await Promise.all([
      this.db
        .from('sales')
        .select('subtotal, discount, total, customer_id')
        .eq('id', saleId)
        .single<{
          subtotal: number | null;
          discount: number | null;
          total: number | null;
          customer_id: number | null;
        }>(),
      this.db
        .from('sale_items')
        .select('id, product_id, quantity, unit_price, subtotal, products(name)')
        .eq('sale_id', saleId)
        .returns<
          {
            id: number;
            product_id: number;
            quantity: number | null;
            unit_price: number | null;
            subtotal: number | null;
            products: { name: string } | null;
          }[]
        >(),
      this.db
        .from('payments')
        .select('method, amount')
        .eq('sale_id', saleId)
        .returns<{ method: PaymentMethod; amount: number | null }[]>()
    ]);

    if (sale.error) throw sale.error;
    if (items.error) throw items.error;
    if (payments.error) throw payments.error;

    return {
      saleId,
      subtotal: sale.data?.subtotal ?? 0,
      discount: sale.data?.discount ?? 0,
      total: sale.data?.total ?? 0,
      customerId: sale.data?.customer_id ?? null,
      items: (items.data ?? []).map((r) => ({
        id: r.id,
        productId: r.product_id,
        productName: r.products?.name ?? 'Producto',
        quantity: r.quantity ?? 0,
        unitPrice: r.unit_price ?? 0,
        subtotal: r.subtotal ?? (r.unit_price ?? 0) * (r.quantity ?? 0)
      })),
      payments: (payments.data ?? []).map((p) => ({
        method: p.method,
        amount: p.amount ?? 0
      }))
    };
  }

  /**
   * Edita una venta ya registrada (solo admin; la RPC lo verifica). Ajusta el
   * inventario según la diferencia de cantidades, reemplaza el pago y reconcilia
   * la cuenta del cliente. Devuelve el resumen de cobro actualizado.
   */
  async updateSale(input: UpdateSaleInput): Promise<CreateSaleResult> {
    const items = input.items
      .filter((i) => Number(i.quantity) > 0)
      .map((i) => ({
        product_id: Number(i.product_id),
        quantity: Math.trunc(Number(i.quantity))
      }));

    const hasPayment = !!input.payment && Number(input.payment.amount) > 0;

    const { data, error } = await this.db.rpc('update_sale', {
      p_sale_id: input.saleId,
      p_customer_id: input.customerId ? Number(input.customerId) : null,
      p_discount: Math.max(0, Math.round(Number(input.discount) || 0)),
      p_items: items,
      p_method: hasPayment ? input.payment!.method : null,
      p_amount: hasPayment ? Math.round(Number(input.payment!.amount)) : 0
    });

    if (error) {
      throw error;
    }

    const r = (data ?? {}) as {
      sale_id?: string;
      invoice_number?: number | null;
      subtotal?: number;
      discount?: number;
      total?: number;
      paid?: number;
      pending?: number;
      status?: SaleStatus;
    };
    const total = Number(r.total ?? 0);
    const paid = Number(r.paid ?? 0);
    return {
      saleId: String(r.sale_id ?? input.saleId),
      invoiceNumber: r.invoice_number ?? null,
      subtotal: Number(r.subtotal ?? 0),
      discount: Number(r.discount ?? 0),
      total,
      paid,
      pending: Number(r.pending ?? Math.max(0, total - paid)),
      status: r.status ?? deriveStatus(total, paid)
    };
  }

  /** Suma y cantidad de ventas creadas desde `fromIso` (ISO 8601). */
  async summarySince(fromIso: string): Promise<SalesSummary> {
    const { data, error } = await this.db
      .from('sales')
      .select('total')
      .gte('created_at', fromIso)
      .returns<{ total: number | null }[]>();

    if (error) {
      throw error;
    }

    const rows = data ?? [];
    return {
      total: rows.reduce((acc, r) => acc + (r.total ?? 0), 0),
      count: rows.length
    };
  }

  /**
   * Saldo pendiente por cobrar de las ventas creadas desde `fromIso`.
   * pendiente = Σ max(0, total - Σ pagos).
   *
   * Limitación: se acota a una ventana de tiempo para no escanear toda la
   * tabla en cada carga. El total exacto de toda la historia debería salir
   * de una vista/RPC en Supabase (fase de base de datos).
   */
  async outstandingSince(fromIso: string): Promise<number> {
    const { data: sales, error } = await this.db
      .from('sales')
      .select('id, total')
      .gte('created_at', fromIso)
      .returns<{ id: string; total: number | null }[]>();

    if (error) {
      throw error;
    }

    const rows = sales ?? [];
    if (rows.length === 0) {
      return 0;
    }

    const paidBySale = await this.paidBySale(rows.map((r) => r.id));

    return rows.reduce((acc, r) => {
      const balance = (r.total ?? 0) - (paidBySale.get(r.id) ?? 0);
      return acc + Math.max(0, balance);
    }, 0);
  }

  /** Últimas ventas con nombre de empleado, cliente y estado de cobro. */
  async recent(limit = 8): Promise<RecentSale[]> {
    const { data, error } = await this.db
      .from('sales')
      .select('id, invoice_number, total, status, customer_id, user_id, created_at')
      .order('created_at', { ascending: false })
      .limit(limit)
      .returns<
        {
          id: string;
          invoice_number: number | null;
          total: number | null;
          status: SaleStatus | null;
          customer_id: number | null;
          user_id: string | null;
          created_at: string;
        }[]
      >();

    if (error) {
      throw error;
    }

    const rows = data ?? [];
    if (rows.length === 0) {
      return [];
    }

    const employeeIds = unique(rows.map((r) => r.user_id));
    const customerIds = unique(rows.map((r) => r.customer_id));

    const [employees, customers, paidBySale] = await Promise.all([
      this.namesFrom('profiles', employeeIds),
      this.namesFrom('customers', customerIds),
      this.paidBySale(rows.map((r) => r.id))
    ]);

    return rows.map((r) => {
      const paid = paidBySale.get(r.id) ?? 0;
      return {
        id: r.id,
        invoiceNumber: r.invoice_number,
        total: r.total ?? 0,
        status: r.status ?? deriveStatus(r.total ?? 0, paid),
        createdAt: r.created_at,
        employeeName: r.user_id ? employees.get(r.user_id) ?? null : null,
        customerName: r.customer_id ? customers.get(r.customer_id) ?? null : null
      };
    });
  }

  /** Total pagado por venta, para el conjunto de ids indicado. */
  private async paidBySale(saleIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (saleIds.length === 0) {
      return result;
    }

    const { data, error } = await this.db
      .from('payments')
      .select('sale_id, amount')
      .in('sale_id', saleIds)
      .returns<{ sale_id: string; amount: number | null }[]>();

    if (error) {
      throw error;
    }

    for (const p of data ?? []) {
      result.set(p.sale_id, (result.get(p.sale_id) ?? 0) + (p.amount ?? 0));
    }
    return result;
  }

  /**
   * Pagado por venta, separado en efectivo ('cash') y "transferencias"
   * (nequi + transferencia + tarjeta). Para el resumen del listado.
   */
  private async paidByMethod(
    saleIds: string[]
  ): Promise<Map<string, { cash: number; transfer: number }>> {
    const result = new Map<string, { cash: number; transfer: number }>();
    if (saleIds.length === 0) {
      return result;
    }

    const { data, error } = await this.db
      .from('payments')
      .select('sale_id, method, amount')
      .in('sale_id', saleIds)
      .returns<{ sale_id: string; method: PaymentMethod; amount: number | null }[]>();

    if (error) {
      throw error;
    }

    for (const p of data ?? []) {
      const bucket = result.get(p.sale_id) ?? { cash: 0, transfer: 0 };
      if (p.method === 'cash') {
        bucket.cash += p.amount ?? 0;
      } else {
        bucket.transfer += p.amount ?? 0;
      }
      result.set(p.sale_id, bucket);
    }
    return result;
  }

  /**
   * Diccionario id -> nombre. La columna del nombre es `name` en ambas tablas
   * (`profiles.name` = uuid, `customers.name` = bigint).
   */
  private async namesFrom<T extends string | number>(
    table: 'profiles' | 'customers',
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

function unique<T extends string | number>(values: (T | null)[]): T[] {
  return [...new Set(values.filter((v): v is T => v !== null && v !== undefined))];
}

/** Inicio (ISO) de la ventana de tiempo del listado, o null para "todo". */
function rangeStartIso(range: SalesRange): string | null {
  const now = new Date();
  switch (range) {
    case 'today': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return start.toISOString();
    }
    case 'week':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case 'month':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    default:
      return null;
  }
}

function deriveStatus(total: number, paid: number): SaleStatus {
  if (paid <= 0) {
    return 'pending';
  }
  if (paid + 0.01 >= total) {
    return 'paid';
  }
  return 'partial';
}
