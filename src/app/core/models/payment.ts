/**
 * Modelo de pago.
 *
 * El sistema NO mueve dinero: un pago solo REGISTRA administrativamente cómo
 * se cobró (o abonó) una venta. El "pendiente" de una venta se calcula como
 * `sales.total - suma(payments.amount)`; nunca existe un método `pending`.
 *
 * Tabla `payments` (Supabase):
 *   id          bigint identity
 *   sale_id     bigint -> sales.id
 *   method      text  ('efectivo' | 'nequi' | 'daviplata' | 'tarjeta' | 'transferencia')
 *   amount      numeric
 *   created_at  timestamptz
 */

export type PaymentMethod =
  | 'efectivo'
  | 'nequi'
  | 'daviplata'
  | 'tarjeta'
  | 'transferencia';

export interface Payment {
  id: number;
  sale_id: number;
  method: PaymentMethod;
  amount: number;
  created_at: string;
}
