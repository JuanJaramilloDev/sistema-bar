/**
 * Modelo de pago.
 *
 * El sistema NO mueve dinero real: un pago solo REGISTRA administrativamente
 * cómo se cobró (o abonó) una venta, para tener control y sacar reportes. El
 * "pendiente" de una venta se calcula como `sales.total - suma(payments.amount)`;
 * nunca existe un método `pending`.
 *
 * Tabla `payments` (Supabase):
 *   id             bigint identity
 *   sale_id        uuid -> sales.id
 *   payment_method USER-DEFINED (enum), solo usamos 'cash' | 'transfer' | 'card'
 *   amount         numeric
 *   created_at     timestamptz
 */

export type PaymentMethod = 'cash' | 'transfer' | 'card';

/** Métodos de pago admitidos, en orden de uso. Fuente única para los `<select>`. */
export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'cash',
  'transfer',
  'card'
] as const;

/** Etiqueta legible de cada método (para tablas y formularios). */
export function paymentMethodLabel(method: PaymentMethod | string | null): string {
  switch (method) {
    case 'cash':
      return 'Efectivo';
    case 'transfer':
      return 'Transferencia';
    case 'card':
      return 'Tarjeta';
    default:
      return '—';
  }
}

export interface Payment {
  id: number;
  sale_id: string;
  payment_method: PaymentMethod;
  amount: number;
  created_at: string;
}
