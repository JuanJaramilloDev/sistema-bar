import type { PaymentMethod } from './payment';

/**
 * Modelos de venta.
 *
 * Tabla `sales` (Supabase) — esquema REAL confirmado 2026-09-10:
 *   id             uuid              (PK)  ← NO bigint
 *   invoice_number bigint
 *   user_id        uuid              -> profiles.id  (empleado que registró) ← NO `employee_id`
 *   customer_id    bigint | null     -> customers.id. NO obligatorio: solo se
 *                                       asigna cuando queda saldo pendiente y la
 *                                       venta va a la cuenta de un cliente.
 *   subtotal       numeric
 *   discount       numeric
 *   total          numeric
 *   status         sale_status       (enum: 'pending' | 'partial' | 'paid')
 *   created_at     timestamptz
 *
 * Tabla `sale_items` (Supabase):
 *   id         bigint identity
 *   sale_id    bigint -> sales.id
 *   product_id bigint -> products.id
 *   quantity   int
 *   unit_price numeric   (copia del precio al momento de la venta, NO FK viva)
 *   subtotal   numeric   (quantity * unit_price)
 *
 * REGLA CLAVE: Angular NUNCA inserta en `sales` / `sale_items` / `payments` ni
 * descuenta `inventory`. Todo eso ocurre en UNA transacción dentro de la RPC
 * `create_sale` de Postgres (ver core/services/sales.ts).
 *
 * Los nombres de columna solo se referencian en `core/services/sales.ts`.
 */

/** Estado de cobro de una venta. Si `sales.status` no existe, se deriva de los pagos. */
export type SaleStatus = 'paid' | 'partial' | 'pending';

export interface Sale {
  /** uuid */
  id: string;
  invoice_number: number | null;
  subtotal: number;
  discount: number;
  total: number;
  status: SaleStatus | null;
  customer_id: number | null;
  /** uuid -> profiles.id (empleado) */
  user_id: string;
  created_at: string;
}

/** Fila lista para pintar en la tabla "ventas recientes". */
export interface RecentSale {
  id: string;
  invoiceNumber: number | null;
  total: number;
  status: SaleStatus;
  createdAt: string;
  employeeName: string | null;
  customerName: string | null;
}

/** Agregado de ventas en una ventana de tiempo. */
export interface SalesSummary {
  total: number;
  count: number;
}

/* -------------------------------------------------------------------------
   Registrar una venta (Fase 6)
   ------------------------------------------------------------------------- */

/**
 * Línea del carrito en la pantalla de venta. Solo vive en el navegador; el
 * precio y el stock se re-validan en el servidor al confirmar.
 */
export interface CartLine {
  productId: number;
  name: string;
  unitPrice: number;
  available: number;
  quantity: number;
}

/** Ítem que se envía a la RPC. `unit_price` es orientativo: el servidor manda. */
export interface SaleItemInput {
  product_id: number;
  quantity: number;
  unit_price: number;
}

/** Pago inicial opcional al registrar la venta. */
export interface SalePaymentInput {
  method: PaymentMethod;
  amount: number;
}

/** Todo lo necesario para `create_sale`. */
export interface CreateSaleInput {
  /** Obligatorio solo si queda saldo pendiente (la venta va a su cuenta). */
  customerId: number | null;
  discount: number;
  items: SaleItemInput[];
  /** null = no se registró ningún pago todavía (queda 100% pendiente). */
  payment: SalePaymentInput | null;
}

/**
 * Editar una venta ya registrada (solo admin). `items` es el conjunto COMPLETO
 * de líneas que quedan (cantidad > 0). La RPC `update_sale` calcula la
 * diferencia contra las líneas actuales y ajusta el inventario en consecuencia
 * (si baja la cantidad, la diferencia vuelve al stock), reemplaza el pago y
 * reconcilia la cuenta del cliente. Todo en una transacción.
 */
export interface UpdateSaleInput {
  saleId: string;
  customerId: number | null;
  discount: number;
  items: SaleItemInput[];
  payment: SalePaymentInput | null;
}

/** Lo que devuelve la RPC `create_sale`. */
export interface CreateSaleResult {
  saleId: string;
  invoiceNumber: number | null;
  subtotal: number;
  discount: number;
  total: number;
  paid: number;
  pending: number;
  status: SaleStatus;
}

/** Fila del listado de ventas (módulo Ventas / Facturas). */
export interface SaleListRow {
  id: string;
  invoiceNumber: number | null;
  subtotal: number;
  discount: number;
  total: number;
  /** pagado en efectivo (method = 'cash') */
  paidCash: number;
  /** pagado por nequi + transferencia + tarjeta */
  paidTransfer: number;
  paid: number;
  pending: number;
  status: SaleStatus;
  customerId: number | null;
  createdAt: string;
  employeeName: string | null;
  customerName: string | null;
}

/** Una línea de una venta, ya resuelta para pintar / editar. */
export interface SaleItemRow {
  id: number;
  productId: number;
  productName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

/** Un registro de pago de una venta. */
export interface SalePaymentRow {
  method: PaymentMethod;
  amount: number;
}

/** Detalle completo de una venta (para desplegar la fila / editar). */
export interface SaleDetail {
  saleId: string;
  subtotal: number;
  discount: number;
  total: number;
  customerId: number | null;
  items: SaleItemRow[];
  payments: SalePaymentRow[];
}

/** Filtro de rango de fechas del listado. */
export type SalesRange = 'today' | 'week' | 'month' | 'all';
