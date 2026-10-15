import { Injectable, inject } from '@angular/core';
import { Supabase, assertAffected } from './supabase';
import type { Closing, ClosingInput, PeriodNumbers } from '../models/closing';

/**
 * Cierres semanales / mensuales (solo admin; lo impone la RLS y la RPC).
 *
 *  - `numbers()` calcula en vivo los números de un rango (RPC `month_close`).
 *  - `save()` guarda la foto del cierre en `closings` (si ya existe el cierre
 *    de ese periodo, lo reemplaza).
 */
@Injectable({ providedIn: 'root' })
export class Closings {

  private readonly supabase = inject(Supabase);

  private get db() {
    return this.supabase.getClient();
  }

  private static readonly COLUMNS =
    'id, kind, period_start, period_end, sales_count, gross, discounts, total, cost, ' +
    'commission_pct, commissions, fixed_expenses, profit, collected, pending, should_remain, ' +
    'promoters, expenses, notes, closed_at';

  async numbers(from: Date, to: Date): Promise<PeriodNumbers> {
    const { data, error } = await this.db.rpc('month_close', {
      p_from: from.toISOString(),
      p_to: to.toISOString()
    });

    if (error) {
      throw error;
    }
    const r = (data ?? {}) as Partial<Record<keyof PeriodNumbers, number | null>>;
    return {
      count: Number(r.count ?? 0),
      gross: Number(r.gross ?? 0),
      discounts: Number(r.discounts ?? 0),
      total: Number(r.total ?? 0),
      collected: Number(r.collected ?? 0),
      pending: Number(r.pending ?? 0),
      cost: Number(r.cost ?? 0)
    };
  }

  /** Todos los cierres guardados, del más reciente al más viejo. */
  async list(): Promise<Closing[]> {
    const { data, error } = await this.db
      .from('closings')
      .select(Closings.COLUMNS)
      .order('period_start', { ascending: false })
      .order('kind', { ascending: true })
      .returns<Closing[]>();

    if (error) {
      throw error;
    }
    return (data ?? []).map(toClosing);
  }

  async save(input: ClosingInput): Promise<Closing> {
    const { data, error } = await this.db
      .from('closings')
      .upsert(
        { ...input, closed_at: new Date().toISOString() },
        { onConflict: 'kind,period_start' }
      )
      .select(Closings.COLUMNS)
      .single<Closing>();

    if (error) {
      throw error;
    }
    return toClosing(data);
  }

  async remove(id: number): Promise<void> {
    const { data, error } = await this.db
      .from('closings')
      .delete()
      .eq('id', id)
      .select('id');

    if (error) {
      throw error;
    }
    assertAffected(data, 'el cierre no se eliminó');
  }
}

/** numeric de Postgres puede llegar como texto: se normaliza a número. */
function toClosing(r: Closing): Closing {
  return {
    ...r,
    sales_count: Number(r.sales_count),
    gross: Number(r.gross),
    discounts: Number(r.discounts),
    total: Number(r.total),
    cost: Number(r.cost),
    commission_pct: Number(r.commission_pct),
    commissions: Number(r.commissions),
    fixed_expenses: Number(r.fixed_expenses ?? 0),
    profit: Number(r.profit),
    collected: Number(r.collected),
    pending: Number(r.pending),
    should_remain: Number(r.should_remain),
    promoters: Array.isArray(r.promoters) ? r.promoters : [],
    expenses: Array.isArray(r.expenses) ? r.expenses : []
  };
}
