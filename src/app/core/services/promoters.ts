import { Injectable, inject } from '@angular/core';
import { Supabase, assertAffected } from './supabase';
import type {
  Promoter,
  PromoterInput,
  PromoterPayout,
  PromoterReportRow
} from '../models/promoter';

/**
 * Acceso a `promoters`. Toda comunicación con Supabase pasa por aquí.
 *
 * Permisos (los impone la RLS de Supabase, no este servicio):
 *   - empleado y admin: consultar (el POS lista los códigos)
 *   - solo admin: crear, editar, activar/desactivar, eliminar
 *
 * Códigos duplicados: índice único en `lower(code)` -> code 23505.
 *
 * Comisión: un solo porcentaje para todas, en `promoter_settings` (fila id=1).
 * Pagos de comisión: `promoter_payouts`, uno por promotora y mes (solo admin).
 */
@Injectable({ providedIn: 'root' })
export class Promoters {

  private readonly supabase = inject(Supabase);

  private get db() {
    return this.supabase.getClient();
  }

  private static readonly COLUMNS = 'id, code, name, active, created_at';

  /** Todas las promotoras, ordenadas por código. */
  async list(): Promise<Promoter[]> {
    const { data, error } = await this.db
      .from('promoters')
      .select(Promoters.COLUMNS)
      .order('code', { ascending: true })
      .returns<Promoter[]>();

    if (error) {
      throw error;
    }
    return data ?? [];
  }

  async create(input: PromoterInput): Promise<Promoter> {
    const { data, error } = await this.db
      .from('promoters')
      .insert(toRow(input))
      .select(Promoters.COLUMNS)
      .single<Promoter>();

    if (error) {
      throw error;
    }
    return data;
  }

  async update(id: number, input: PromoterInput): Promise<Promoter> {
    const { data, error } = await this.db
      .from('promoters')
      .update(toRow(input))
      .eq('id', id)
      .select(Promoters.COLUMNS)
      .single<Promoter>();

    if (error) {
      throw error;
    }
    return data;
  }

  async setActive(id: number, active: boolean): Promise<void> {
    const { data, error } = await this.db
      .from('promoters')
      .update({ active })
      .eq('id', id)
      .select('id');

    if (error) {
      throw error;
    }
    assertAffected(data, 'no se pudo cambiar el estado de la promotora');
  }

  /** Elimina la promotora. Falla (FK 23503) si ya tiene ventas con su código. */
  async remove(id: number): Promise<void> {
    const { data, error } = await this.db
      .from('promoters')
      .delete()
      .eq('id', id)
      .select('id');

    if (error) {
      throw error;
    }
    assertAffected(data, 'la promotora no se eliminó');
  }

  /** Porcentaje de comisión vigente (igual para todas las promotoras). */
  async commissionPct(): Promise<number> {
    const { data, error } = await this.db
      .from('promoter_settings')
      .select('commission_pct')
      .eq('id', 1)
      .maybeSingle<{ commission_pct: number | null }>();

    if (error) {
      throw error;
    }
    return Number(data?.commission_pct ?? 0);
  }

  /** Cambia el porcentaje de comisión (solo admin; 0 a 100). */
  async setCommissionPct(pct: number): Promise<void> {
    const { data, error } = await this.db
      .from('promoter_settings')
      .update({ commission_pct: pct, updated_at: new Date().toISOString() })
      .eq('id', 1)
      .select('id');

    if (error) {
      throw error;
    }
    assertAffected(data, 'no se pudo guardar el porcentaje');
  }

  /** Comisiones pagadas de un mes (`period` = `YYYY-MM-01`). */
  async payouts(period: string): Promise<PromoterPayout[]> {
    const { data, error } = await this.db
      .from('promoter_payouts')
      .select('id, promoter_id, period, amount, notes, paid_at')
      .eq('period', period)
      .returns<PromoterPayout[]>();

    if (error) {
      throw error;
    }
    return data ?? [];
  }

  /** Registra que se le pagó la comisión del mes a una promotora. */
  async markPaid(
    promoterId: number,
    period: string,
    amount: number,
    notes: string | null
  ): Promise<PromoterPayout> {
    const trimmed = (notes ?? '').trim();
    const { data, error } = await this.db
      .from('promoter_payouts')
      .insert({
        promoter_id: promoterId,
        period,
        amount: Math.max(0, Math.round(amount)),
        notes: trimmed.length ? trimmed : null
      })
      .select('id, promoter_id, period, amount, notes, paid_at')
      .single<PromoterPayout>();

    if (error) {
      throw error;
    }
    return data;
  }

  /** Deshace un pago registrado por error. */
  async undoPayout(id: number): Promise<void> {
    const { data, error } = await this.db
      .from('promoter_payouts')
      .delete()
      .eq('id', id)
      .select('id');

    if (error) {
      throw error;
    }
    assertAffected(data, 'el pago no se eliminó');
  }

  /** Ventas por promotora en [from, to). */
  async report(from: Date, to: Date): Promise<PromoterReportRow[]> {
    const { data, error } = await this.db.rpc('promoter_report', {
      p_from: from.toISOString(),
      p_to: to.toISOString()
    });

    if (error) {
      throw error;
    }
    return ((data as ReportRowDb[] | null) ?? []).map((r) => ({
      promoterId: r.promoter_id,
      code: r.code,
      name: r.name,
      active: r.active,
      salesCount: Number(r.sales_count ?? 0),
      paidCount: Number(r.paid_count ?? 0),
      paidTotal: Number(r.paid_total ?? 0),
      pendingCount: Number(r.pending_count ?? 0),
      pendingTotal: Number(r.pending_total ?? 0)
    }));
  }
}

/** Fila cruda que devuelve la RPC `promoter_report`. */
interface ReportRowDb {
  promoter_id: number;
  code: string;
  name: string;
  active: boolean;
  sales_count: number | null;
  paid_count: number | null;
  paid_total: number | null;
  pending_count: number | null;
  pending_total: number | null;
}

/** El código se guarda en mayúsculas y sin espacios para que sea fácil de dictar. */
function toRow(input: PromoterInput): { code: string; name: string } {
  return {
    code: input.code.replace(/\s+/g, '').toUpperCase(),
    name: input.name.trim()
  };
}
