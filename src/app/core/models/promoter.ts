/**
 * Fila de la tabla `promoters` de Supabase.
 *   id (bigint identity), code (único, sin distinguir mayúsculas), name, active, created_at
 *
 * Cada venta puede llevar el código de una promotora (`sales.promoter_id`);
 * a fin de mes se le paga un porcentaje de lo vendido con su código.
 */
export interface Promoter {
  id: number;
  code: string;
  name: string;
  active: boolean;
  created_at: string;
}

/** Campos editables de una promotora (crear / editar). */
export interface PromoterInput {
  code: string;
  name: string;
}

/**
 * Fila del reporte `promoter_report` (RPC, solo admin) para un rango de fechas.
 * Solo las ventas pagadas por completo (sin deuda) cuentan para la comisión;
 * las que aún deben se muestran aparte y entran cuando se terminan de pagar.
 */
export interface PromoterReportRow {
  promoterId: number;
  code: string;
  name: string;
  active: boolean;
  salesCount: number;
  paidCount: number;
  paidTotal: number;
  pendingCount: number;
  pendingTotal: number;
}

/**
 * Comisión ya pagada a una promotora (tabla `promoter_payouts`, solo admin).
 *   period = primer día del mes pagado (`YYYY-MM-01`). Una por promotora y mes.
 */
export interface PromoterPayout {
  id: number;
  promoter_id: number;
  period: string;
  amount: number;
  notes: string | null;
  paid_at: string;
}
