import type { PaymentMethod } from './payment';

/**
 * Modelos de venta.
 *
 * Tabla `sales` (Supabase) — esquema REAL:
 *   id             uuid              (PK)
 *   invoice_number bigint            (lo genera Postgres, nunca Angular)
 *   user_id        uuid              -> profiles.id  (empleado que registró)
 *   customer_id    bigint | null     -> customers.id. Solo se asigna cuando
 *                                       queda saldo pendiente (abono parcial).
 *   subtotal       numeric
 *   discount       numeric
 *   total          numeric
 *   status         sale_status       (enum REAL: 'completed' | 'cancelled')
 *   created_at     timestamptz
 *
 * OJO: `sales.status` NO indica si la venta está pagada o no — solo si sigue
 * vigente (`completed`) o fue anulada (`cancelled`). El progreso de cobro
 * (pagada / con abono) se calcula SIEMPRE en el cliente/servicio a partir de
 * `total` vs. la suma de `payments.amount`. Ver `PaymentStatus` más abajo.
 *
 * Tabla `sale_items` (Supabase):
 *   id         bigint identity
 *   sale_id    uuid    -> sales.id
 *   product_id bigint  -> products.id
 *   quantity   int
 *   unit_price numeric   (copia del precio al momento de la venta, NO FK viva)
 *   subtotal   numeric   (quantity * unit_price)
 *   method     text | null (columna existente, NO usada por la app; no confundir
 *              con `payments.payment_method`)
 *
 * Tabla `payments` (Supabase):
 *   id             bigint identity
 *   sale_id        uuid -> sales.id
 *   payment_method enum, solo usamos 'cash' | 'transfer' | 'card'
 *   amount         numeric
 *
 * REGLA CLAVE: Angular NUNCA inserta en `sales` / `sale_items` / `payments` ni
 * descuenta `inventory`. Todo eso ocurre en UNA transacción dentro de la RPC
 * `create_sale` de Postgres (ver core/services/sales.ts). Ya no existe la
 * opción de venta "fiada" (100% pendiente): toda venta exige un pago > 0;
 * si el pago es menor al total, el resto queda en la cuenta del cliente
 * (`customers.cuenta`), y por eso el cliente es obligatorio en ese caso.
 */

/** Estado REAL de la venta en la base de datos. */
export type SaleDbStatus = 'completed' | 'cancelled';

/**
 * Estado de cobro, calculado (NUNCA leído de una columna): compara
 * `total` contra la suma de `payments.amount`.
 */
export type PaymentStatus = 'paid' | 'partial';

/** Alias por compatibilidad de nombres dentro de la app (mismo significado que `PaymentStatus`). */
export type SaleStatus = PaymentStatus;

export interface Sale {
  /** uuid */
  id: string;
  invoice_number: number | null;
  subtotal: number;
  discount: number;
  total: number;
  status: SaleDbStatus;
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
  status: PaymentStatus;
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

/** Pago al registrar la venta. Siempre obligatorio (ya no existe "fiado"). */
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
  /** El monto pagado ahora; puede ser parcial pero nunca 0. */
  payment: SalePaymentInput;
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
  payment: SalePaymentInput;
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
  status: PaymentStatus;
}

/** Fila del listado de ventas (módulo Ventas / Facturas). */
export interface SaleListRow {
  id: string;
  invoiceNumber: number | null;
  subtotal: number;
  discount: number;
  total: number;
  /** pagado en efectivo (payment_method = 'cash') */
  paidCash: number;
  /** pagado por transferencia (payment_method = 'transfer') */
  paidTransfer: number;
  /** pagado con tarjeta (payment_method = 'card') */
  paidCard: number;
  paid: number;
  pending: number;
  status: PaymentStatus;
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

/* -------------------------------------------------------------------------
   Abonos (Fase 7)
   ------------------------------------------------------------------------- */

/** Venta propia con saldo pendiente, para la pantalla "Abonar" del empleado. */
export interface PendingSaleRow {
  id: string;
  invoiceNumber: number | null;
  total: number;
  paid: number;
  pending: number;
  customerId: number;
  customerName: string | null;
  createdAt: string;
}

/** Lo que se envía a la RPC `add_payment`. */
export interface AddPaymentInput {
  saleId: string;
  method: PaymentMethod;
  amount: number;
}

/** Lo que devuelve la RPC `add_payment`. */
export interface AddPaymentResult {
  saleId: string;
  paidNow: number;
  totalPaid: number;
  pending: number;
}

/** Una fila del historial de abonos (admin): un pago que NO fue el inicial de su venta. */
export interface AbonoRow {
  paymentId: number;
  saleId: string;
  invoiceNumber: number | null;
  customerName: string | null;
  employeeName: string | null;
  method: PaymentMethod;
  amount: number;
  createdAt: string;
}
