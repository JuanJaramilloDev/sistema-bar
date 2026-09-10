/**
 * Modelos de venta.
 *
 * Tabla `sales` (Supabase):
 *   id             bigint identity   (PK)
 *   invoice_number int
 *   subtotal       numeric
 *   discount       numeric
 *   total          numeric
 *   status         text | null       ('paid' | 'partial' | 'pending') — opcional
 *   customer_id    bigint | null     -> customers.id. NO obligatorio: solo se
 *                                       asigna cuando la venta va a una cuenta
 *                                       de cliente ya abierta.
 *   employee_id    uuid              -> profiles.id  (quién registró la venta)
 *   created_at     timestamptz
 *
 * Los nombres de columna solo se referencian en `core/services/sales.ts`.
 */

/** Estado de cobro de una venta. Si `sales.status` no existe, se deriva de los pagos. */
export type SaleStatus = 'paid' | 'partial' | 'pending';

export interface Sale {
  id: number;
  invoice_number: number | null;
  subtotal: number;
  discount: number;
  total: number;
  status: SaleStatus | null;
  customer_id: number | null;
  employee_id: string;
  created_at: string;
}

/** Fila lista para pintar en la tabla "ventas recientes". */
export interface RecentSale {
  id: number;
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
