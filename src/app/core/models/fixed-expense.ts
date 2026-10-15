/**
 * Fila de la tabla `fixed_expenses` (solo admin): gasto fijo MENSUAL
 * (arriendo, servicios, nómina…). Los cierres restan el total del mes o la
 * parte de la semana (mensual / 4). Inactivo = no se resta.
 */
export interface FixedExpense {
  id: number;
  name: string;
  monthly_amount: number;
  active: boolean;
  created_at: string;
}

/** Campos editables de un gasto fijo. */
export interface FixedExpenseInput {
  name: string;
  monthly_amount: number;
}
