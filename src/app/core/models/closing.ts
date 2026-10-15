/** Tipo de cierre: semanal (lunes a domingo) o mensual. */
export type ClosingKind = 'week' | 'month';

/** Números crudos de un periodo (RPC `month_close`). */
export interface PeriodNumbers {
  count: number;
  /** Ventas antes de descuentos. */
  gross: number;
  discounts: number;
  /** Total vendido (ya con descuentos y sin lo devuelto). */
  total: number;
  /** Lo que ya se cobró de esas ventas. */
  collected: number;
  /** Lo que todavía deben los clientes de esas ventas. */
  pending: number;
  /** Costo de lo vendido = lo que toca dejar para reponer. */
  cost: number;
}

/** Comisión de una promotora dentro de un cierre. */
export interface ClosingPromoterLine {
  code: string;
  name: string;
  /** Vendido y pagado con su código (en el cierre semanal: en el MES de la semana). */
  paid_total: number;
  /** Lo que se resta en este cierre (en el semanal: comisión del mes / 4). */
  commission: number;
  /** Comisión del mes completo (solo en cierres semanales). */
  monthly_commission?: number;
}

/** Gasto fijo apartado en un cierre (valor del periodo, no el mensual). */
export interface ClosingExpenseLine {
  name: string;
  monthly_amount: number;
  /** Lo apartado en este cierre: mensual completo o la parte de la semana. */
  amount: number;
}

/**
 * Fila de la tabla `closings` (solo admin): foto de los números de un periodo
 * en el momento de cerrarlo. Uno por tipo y periodo (`period_start`).
 *   period_end es exclusivo (lunes siguiente / día 1 del mes siguiente).
 */
export interface Closing {
  id: number;
  kind: ClosingKind;
  period_start: string;
  period_end: string;
  sales_count: number;
  gross: number;
  discounts: number;
  total: number;
  cost: number;
  commission_pct: number;
  commissions: number;
  /** Gastos fijos apartados en el periodo (mensual o parte semanal). */
  fixed_expenses: number;
  /** total − cost − commissions − fixed_expenses */
  profit: number;
  collected: number;
  pending: number;
  /** total − commissions (= reponer + ganancia) */
  should_remain: number;
  promoters: ClosingPromoterLine[];
  expenses: ClosingExpenseLine[];
  notes: string | null;
  closed_at: string;
}

/** Lo que se guarda al hacer un cierre. */
export type ClosingInput = Omit<Closing, 'id' | 'closed_at'>;
