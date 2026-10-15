import { Injectable, inject } from '@angular/core';
import { Supabase, assertAffected } from './supabase';
import type { FixedExpense, FixedExpenseInput } from '../models/fixed-expense';

/** Acceso a `fixed_expenses` (solo admin; lo impone la RLS). */
@Injectable({ providedIn: 'root' })
export class FixedExpenses {

  private readonly supabase = inject(Supabase);

  private get db() {
    return this.supabase.getClient();
  }

  private static readonly COLUMNS = 'id, name, monthly_amount, active, created_at';

  async list(): Promise<FixedExpense[]> {
    const { data, error } = await this.db
      .from('fixed_expenses')
      .select(FixedExpenses.COLUMNS)
      .order('name', { ascending: true })
      .returns<FixedExpense[]>();

    if (error) {
      throw error;
    }
    return (data ?? []).map((e) => ({ ...e, monthly_amount: Number(e.monthly_amount) }));
  }

  async create(input: FixedExpenseInput): Promise<FixedExpense> {
    const { data, error } = await this.db
      .from('fixed_expenses')
      .insert(toRow(input))
      .select(FixedExpenses.COLUMNS)
      .single<FixedExpense>();

    if (error) {
      throw error;
    }
    return { ...data, monthly_amount: Number(data.monthly_amount) };
  }

  async update(id: number, input: FixedExpenseInput): Promise<FixedExpense> {
    const { data, error } = await this.db
      .from('fixed_expenses')
      .update(toRow(input))
      .eq('id', id)
      .select(FixedExpenses.COLUMNS)
      .single<FixedExpense>();

    if (error) {
      throw error;
    }
    return { ...data, monthly_amount: Number(data.monthly_amount) };
  }

  async setActive(id: number, active: boolean): Promise<void> {
    const { data, error } = await this.db
      .from('fixed_expenses')
      .update({ active })
      .eq('id', id)
      .select('id');

    if (error) {
      throw error;
    }
    assertAffected(data, 'no se pudo cambiar el estado del gasto');
  }

  async remove(id: number): Promise<void> {
    const { data, error } = await this.db
      .from('fixed_expenses')
      .delete()
      .eq('id', id)
      .select('id');

    if (error) {
      throw error;
    }
    assertAffected(data, 'el gasto no se eliminó');
  }
}

function toRow(input: FixedExpenseInput): { name: string; monthly_amount: number } {
  const amount = Number(input.monthly_amount);
  return {
    name: input.name.trim(),
    monthly_amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0
  };
}
