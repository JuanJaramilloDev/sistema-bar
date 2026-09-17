import { Injectable, inject } from '@angular/core';
import { Supabase } from './supabase';
import type {
  AbonoRow,
  AddPaymentInput,
  AddPaymentResult,
  CreateSaleInput,
  CreateSaleResult,
  PaymentStatus,
  PendingSaleRow,
  RecentSale,
  SaleDetail,
  SaleListRow,
  SalesRange,
  SalesSummary,
  UpdateSaleInput
} from '../models/sale';
import type { PaymentMethod } from '../models/payment';

/**
 * Acceso a las ventas.
 *
 * LECTURA: consultas normales. El alcance lo decide la RLS de Supabase:
 *   - employee -> solo sus ventas (de hoy)
 *   - admin    -> todas
 * Este servicio no filtra por empleado; confía en la política.
 *
 * ESCRITURA: registrar una venta NUNCA se hace con inserts sueltos desde
 * Angular. `create()` llama a la RPC `create_sale`, que en UNA transacción:
 * crea la venta + los `sale_items` (con copia del precio) + el pago +
 * descuenta `inventory` + deja los `inventory_movements` + suma el pendiente a
 * la cuenta del cliente. Si algo falla, rollback completo. Ya no existe la
 * venta "fiada": el pago siempre debe ser > 0.
 *
 * Columnas reales (ver también core/models/sale.ts):
 *   sales:    id (uuid), invoice_number, user_id (uuid, empleado), customer_id,
 *             subtotal, discount, total, status ('completed'|'cancelled'), created_at
 *   payments: sale_id (uuid), payment_method ('cash'|'transfer'|'card'), amount
 *   nombre del empleado/cliente -> profiles.name / customers.name
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

    const { data, error } = await this.db.rpc('create_sale', {
      p_customer_id: input.customerId ? Number(input.customerId) : null,
      p_discount: Math.max(0, Math.round(Number(input.discount) || 0)),
      p_items: items,
      p_method: input.payment.method,
      p_amount: Math.round(Number(input.payment.amount))
    });

    if (error) {
      throw error;
    }

    return toCreateSaleResult(data, '');
  }

  /**
   * Listado de ventas para el módulo Ventas / Facturas. El alcance (todas vs.
   * propias) lo impone la RLS. `range` acota por fecha para no escanear todo.
   */
  async list(range: SalesRange = 'week', search = ''): Promise<SaleListRow[]> {
    let query = this.db
      .from('sales')
      .select('id, invoice_number, subtotal, discount, total, customer_id, user_id, created_at')
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
        const bucket = paidByMethod.get(r.id) ?? { cash: 0, transfer: 0, card: 0 };
        const paid = bucket.cash + bucket.transfer + bucket.card;
        return {
          id: r.id,
          invoiceNumber: r.invoice_number,
          subtotal: r.subtotal ?? total,
          discount: r.discount ?? 0,
          total,
          paidCash: bucket.cash,
          paidTransfer: bucket.transfer,
          paidCard: bucket.card,
          paid,
          pending: Math.max(0, total - paid),
          status: derivePaymentStatus(total, paid),
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
        .select('payment_method, amount')
        .eq('sale_id', saleId)
        .returns<{ payment_method: PaymentMethod; amount: number | null }[]>()
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
        method: p.payment_method,
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

    const { data, error } = await this.db.rpc('update_sale', {
      p_sale_id: input.saleId,
      p_customer_id: input.customerId ? Number(input.customerId) : null,
      p_discount: Math.max(0, Math.round(Number(input.discount) || 0)),
      p_items: items,
      p_method: input.payment.method,
      p_amount: Math.round(Number(input.payment.amount))
    });

    if (error) {
      throw error;
    }

    return toCreateSaleResult(data, input.saleId);
  }

  /**
   * Mis ventas (el empleado autenticado) que todavía tienen saldo pendiente,
   * sin importar cuándo se registraron. Base de la pantalla "Abonar".
   */
  async myPending(userId: string): Promise<PendingSaleRow[]> {
    const { data, error } = await this.db
      .from('sales')
      .select('id, invoice_number, customer_id, total, created_at')
      .eq('user_id', userId)
      .not('customer_id', 'is', null)
      .order('created_at', { ascending: false })
      .returns<
        {
          id: string;
          invoice_number: number | null;
          customer_id: number | null;
          total: number | null;
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

    const [customers, paidBySale] = await Promise.all([
      this.namesFrom('customers', unique(rows.map((r) => r.customer_id))),
      this.paidBySale(rows.map((r) => r.id))
    ]);

    return rows
      .map((r) => {
        const total = r.total ?? 0;
        const paid = paidBySale.get(r.id) ?? 0;
        return {
          id: r.id,
          invoiceNumber: r.invoice_number,
          total,
          paid,
          pending: Math.max(0, total - paid),
          customerId: r.customer_id as number,
          customerName: r.customer_id ? customers.get(r.customer_id) ?? null : null,
          createdAt: r.created_at
        } satisfies PendingSaleRow;
      })
      .filter((r) => r.pending > 0);
  }

  /**
   * Abona a una venta (propia, o cualquiera si admin) vía RPC transaccional:
   * guarda el pago y descuenta `customers.cuenta`. No puede exceder el
   * pendiente de esa venta.
   */
  async addPayment(input: AddPaymentInput): Promise<AddPaymentResult> {
    const { data, error } = await this.db.rpc('add_payment', {
      p_sale_id: input.saleId,
      p_method: input.method,
      p_amount: Math.round(Number(input.amount))
    });

    if (error) {
      throw error;
    }

    const r = (data ?? {}) as {
      sale_id?: string;
      paid_now?: number;
      total_paid?: number;
      pending?: number;
    };
    return {
      saleId: String(r.sale_id ?? input.saleId),
      paidNow: Number(r.paid_now ?? 0),
      totalPaid: Number(r.total_paid ?? 0),
      pending: Number(r.pending ?? 0)
    };
  }

  /**
   * Historial de abonos (admin): pagos que NO fueron el primero de su venta
   * (el primero se registra al crear la venta; los siguientes son abonos
   * posteriores vía `addPayment`). `range` filtra por la fecha del ABONO,
   * no de la venta original.
   */
  async abonosHistory(range: SalesRange = 'week', search = ''): Promise<AbonoRow[]> {
    let query = this.db
      .from('payments')
      .select('id, sale_id, payment_method, amount, created_at')
      .order('created_at', { ascending: false })
      .limit(500);

    const from = rangeStartIso(range);
    if (from) {
      query = query.gte('created_at', from);
    }

    const { data, error } = await query.returns<
      { id: number; sale_id: string; payment_method: PaymentMethod; amount: number | null; created_at: string }[]
    >();
    if (error) {
      throw error;
    }

    const candidates = data ?? [];
    if (candidates.length === 0) {
      return [];
    }

    const saleIds = unique(candidates.map((c) => c.sale_id));

    // El primer pago (id más chico) de cada venta es el pago inicial, no un
    // abono. Se busca en TODO el historial de esa venta, no solo en `range`.
    const { data: allPays, error: allErr } = await this.db
      .from('payments')
      .select('id, sale_id')
      .in('sale_id', saleIds)
      .returns<{ id: number; sale_id: string }[]>();
    if (allErr) {
      throw allErr;
    }

    const firstIdBySale = new Map<string, number>();
    for (const p of allPays ?? []) {
      const current = firstIdBySale.get(p.sale_id);
      if (current === undefined || p.id < current) {
        firstIdBySale.set(p.sale_id, p.id);
      }
    }

    const abonos = candidates.filter((c) => firstIdBySale.get(c.sale_id) !== c.id);
    if (abonos.length === 0) {
      return [];
    }

    const abonoSaleIds = unique(abonos.map((c) => c.sale_id));
    const { data: sales, error: salesErr } = await this.db
      .from('sales')
      .select('id, invoice_number, customer_id, user_id')
      .in('id', abonoSaleIds)
      .returns<{ id: string; invoice_number: number | null; customer_id: number | null; user_id: string | null }[]>();
    if (salesErr) {
      throw salesErr;
    }

    const saleById = new Map((sales ?? []).map((s) => [s.id, s]));
    const [employees, customers] = await Promise.all([
      this.namesFrom('profiles', unique((sales ?? []).map((s) => s.user_id))),
      this.namesFrom('customers', unique((sales ?? []).map((s) => s.customer_id)))
    ]);

    const term = search.trim().toLowerCase();

    return abonos
      .map((c) => {
        const s = saleById.get(c.sale_id);
        return {
          paymentId: c.id,
          saleId: c.sale_id,
          invoiceNumber: s?.invoice_number ?? null,
          customerName: s?.customer_id ? customers.get(s.customer_id) ?? null : null,
          employeeName: s?.user_id ? employees.get(s.user_id) ?? null : null,
          method: c.payment_method,
          amount: c.amount ?? 0,
          createdAt: c.created_at
        } satisfies AbonoRow;
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
      .select('id, invoice_number, total, customer_id, user_id, created_at')
      .order('created_at', { ascending: false })
      .limit(limit)
      .returns<
        {
          id: string;
          invoice_number: number | null;
          total: number | null;
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
        status: derivePaymentStatus(r.total ?? 0, paid),
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
   * Pagado por venta, separado por método ('cash' | 'transfer' | 'card').
   * Para el resumen del listado y, más adelante, reportes de caja.
   */
  private async paidByMethod(
    saleIds: string[]
  ): Promise<Map<string, { cash: number; transfer: number; card: number }>> {
    const result = new Map<string, { cash: number; transfer: number; card: number }>();
    if (saleIds.length === 0) {
      return result;
    }

    const { data, error } = await this.db
      .from('payments')
      .select('sale_id, payment_method, amount')
      .in('sale_id', saleIds)
      .returns<{ sale_id: string; payment_method: PaymentMethod; amount: number | null }[]>();

    if (error) {
      throw error;
    }

    for (const p of data ?? []) {
      const bucket = result.get(p.sale_id) ?? { cash: 0, transfer: 0, card: 0 };
      if (p.payment_method === 'cash') {
        bucket.cash += p.amount ?? 0;
      } else if (p.payment_method === 'card') {
        bucket.card += p.amount ?? 0;
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

/** Estado de cobro calculado (nunca leído de `sales.status`, que es completed/cancelled). */
function derivePaymentStatus(total: number, paid: number): PaymentStatus {
  return paid + 0.01 >= total ? 'paid' : 'partial';
}

function toCreateSaleResult(data: unknown, fallbackId: string): CreateSaleResult {
  const r = (data ?? {}) as {
    sale_id?: string;
    invoice_number?: number | null;
    subtotal?: number;
    discount?: number;
    total?: number;
    paid?: number;
    pending?: number;
  };
  const total = Number(r.total ?? 0);
  const paid = Number(r.paid ?? 0);
  const pending = Number(r.pending ?? Math.max(0, total - paid));
  return {
    saleId: String(r.sale_id ?? fallbackId),
    invoiceNumber: r.invoice_number ?? null,
    subtotal: Number(r.subtotal ?? 0),
    discount: Number(r.discount ?? 0),
    total,
    paid,
    pending,
    status: derivePaymentStatus(total, paid)
  };
}
