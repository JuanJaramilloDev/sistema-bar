import { Injectable, inject } from '@angular/core';
import { Supabase, assertAffected } from './supabase';
import type { Customer, CustomerInput } from '../models/customer';
import type { PaymentMethod } from '../models/payment';

/**
 * Acceso a `customers`. Toda comunicación con Supabase pasa por aquí.
 *
 * Permisos (los impone la RLS de Supabase, no este servicio):
 *   - empleado y admin: consultar, crear, editar
 *   - solo admin: eliminar
 *
 * Abonos del admin: `payDebt()` (RPC `pay_customer_debt`) reparte el abono
 * entre las ventas pendientes del cliente como pagos reales y baja `cuenta`.
 * Así el historial, los dashboards y los reportes ven la venta pagada.
 */
@Injectable({ providedIn: 'root' })
export class Customers {

  private readonly supabase = inject(Supabase);

  private get db() {
    return this.supabase.getClient();
  }

  private static readonly COLUMNS = 'id, name, phone, notes, cuenta, created_at';

  async list(): Promise<Customer[]> {
    const { data, error } = await this.db
      .from('customers')
      .select(Customers.COLUMNS)
      .order('name', { ascending: true })
      .returns<Customer[]>();

    if (error) {
      throw error;
    }
    return data ?? [];
  }

  async create(input: CustomerInput): Promise<Customer> {
    const { data, error } = await this.db
      .from('customers')
      .insert(toRow(input))
      .select(Customers.COLUMNS)
      .single<Customer>();

    if (error) {
      throw error;
    }
    return data;
  }

  async update(id: number, input: CustomerInput): Promise<Customer> {
    const { data, error } = await this.db
      .from('customers')
      .update(toRow(input))
      .eq('id', id)
      .select(Customers.COLUMNS)
      .single<Customer>();

    if (error) {
      throw error;
    }
    return data;
  }

  /**
   * Abono del admin a la cuenta del cliente. Paga sus ventas pendientes de la
   * más vieja a la más nueva; lo que sobre (saldo cargado a mano) solo baja la
   * cuenta. No puede superar la cuenta. Devuelve la cuenta nueva.
   */
  async payDebt(customerId: number, method: PaymentMethod, amount: number): Promise<number> {
    const { data, error } = await this.db.rpc('pay_customer_debt', {
      p_customer_id: customerId,
      p_method: method,
      p_amount: Math.round(amount)
    });

    if (error) {
      throw error;
    }
    return Number((data as { cuenta?: number } | null)?.cuenta ?? 0);
  }

  /**
   * Elimina el cliente (solo admin). Falla (FK 23503) si tiene ventas.
   * `.select()` para confirmar que se borró de verdad: si la RLS filtra el
   * DELETE, PostgREST no devuelve error pero no borra nada.
   */
  async remove(id: number): Promise<void> {
    const { data, error } = await this.db
      .from('customers')
      .delete()
      .eq('id', id)
      .select('id');

    if (error) {
      throw error;
    }
    assertAffected(data, 'el cliente no se eliminó');
  }
}

function toRow(input: CustomerInput): {
  name: string;
  phone: string | null;
  notes: string | null;
  cuenta: number;
} {
  const cuenta = Number(input.cuenta);
  return {
    name: input.name.trim(),
    phone: nullable(input.phone),
    notes: nullable(input.notes),
    cuenta: Number.isFinite(cuenta) && cuenta > 0 ? Math.round(cuenta) : 0
  };
}

function nullable(value: string | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length ? trimmed : null;
}
