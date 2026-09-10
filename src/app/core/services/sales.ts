import { Injectable, inject } from '@angular/core';
import { Supabase } from './supabase';
import type { RecentSale, SalesSummary, SaleStatus } from '../models/sale';

/**
 * Acceso a las ventas. NO registra ventas todavía (eso es Fase 6, vía RPC
 * transaccional de Postgres). Aquí solo se LEE para dashboards/listados.
 *
 * El alcance lo decide la RLS de Supabase:
 *   - employee -> solo sus ventas
 *   - admin    -> todas
 * Este servicio no filtra por empleado; confía en la política.
 *
 * Columnas (ver también core/models/sale.ts). id = bigint (number) salvo
 * `sales.employee_id` que es uuid (string, -> profiles.id):
 *   sales:    id, invoice_number, total, status, customer_id, employee_id, created_at
 *   payments: sale_id, amount
 *   nombre del empleado/cliente -> profiles.name / customers.name
 * Si tu esquema usa otros nombres, cámbialos SOLO aquí.
 */
@Injectable({ providedIn: 'root' })
export class Sales {

  private readonly supabase = inject(Supabase);

  private get db() {
    return this.supabase.getClient();
  }

  /** Suma y cantidad de ventas creadas desde `fromIso` (ISO 8601). */
  async summarySince(fromIso: string): Promise<SalesSummary> {
    const { data, error } = await this.db
      .from('sales')
      .select('total')
      .gte('created_at', fromIso)
      .returns<{ total: number | null }[]>();

    if (error) {
      throw error;
    }

    const rows = data ?? [];
    return {
      total: rows.reduce((acc, r) => acc + (r.total ?? 0), 0),
      count: rows.length
    };
  }

  /**
   * Saldo pendiente por cobrar de las ventas creadas desde `fromIso`.
   * pendiente = Σ max(0, total - Σ pagos).
   *
   * Limitación: se acota a una ventana de tiempo para no escanear toda la
   * tabla en cada carga. El total exacto de toda la historia debería salir
   * de una vista/RPC en Supabase (fase de base de datos).
   */
  async outstandingSince(fromIso: string): Promise<number> {
    const { data: sales, error } = await this.db
      .from('sales')
      .select('id, total')
      .gte('created_at', fromIso)
      .returns<{ id: number; total: number | null }[]>();

    if (error) {
      throw error;
    }

    const rows = sales ?? [];
    if (rows.length === 0) {
      return 0;
    }

    const paidBySale = await this.paidBySale(rows.map((r) => r.id));

    return rows.reduce((acc, r) => {
      const balance = (r.total ?? 0) - (paidBySale.get(r.id) ?? 0);
      return acc + Math.max(0, balance);
    }, 0);
  }

  /** Últimas ventas con nombre de empleado, cliente y estado de cobro. */
  async recent(limit = 8): Promise<RecentSale[]> {
    const { data, error } = await this.db
      .from('sales')
      .select('id, invoice_number, total, status, customer_id, employee_id, created_at')
      .order('created_at', { ascending: false })
      .limit(limit)
      .returns<
        {
          id: number;
          invoice_number: number | null;
          total: number | null;
          status: SaleStatus | null;
          customer_id: number | null;
          employee_id: string | null;
          created_at: string;
        }[]
      >();

    if (error) {
      throw error;
    }

    const rows = data ?? [];
    if (rows.length === 0) {
      return [];
    }

    const employeeIds = unique(rows.map((r) => r.employee_id));
    const customerIds = unique(rows.map((r) => r.customer_id));

    const [employees, customers, paidBySale] = await Promise.all([
      this.namesFrom('profiles', employeeIds),
      this.namesFrom('customers', customerIds),
      this.paidBySale(rows.map((r) => r.id))
    ]);

    return rows.map((r) => {
      const paid = paidBySale.get(r.id) ?? 0;
      return {
        id: r.id,
        invoiceNumber: r.invoice_number,
        total: r.total ?? 0,
        status: r.status ?? deriveStatus(r.total ?? 0, paid),
        createdAt: r.created_at,
        employeeName: r.employee_id ? employees.get(r.employee_id) ?? null : null,
        customerName: r.customer_id ? customers.get(r.customer_id) ?? null : null
      };
    });
  }

  /** Total pagado por venta, para el conjunto de ids indicado. */
  private async paidBySale(saleIds: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (saleIds.length === 0) {
      return result;
    }

    const { data, error } = await this.db
      .from('payments')
      .select('sale_id, amount')
      .in('sale_id', saleIds)
      .returns<{ sale_id: number; amount: number | null }[]>();

    if (error) {
      throw error;
    }

    for (const p of data ?? []) {
      result.set(p.sale_id, (result.get(p.sale_id) ?? 0) + (p.amount ?? 0));
    }
    return result;
  }

  /**
   * Diccionario id -> nombre. La columna del nombre es `name` en ambas tablas
   * (`profiles.name` = uuid, `customers.name` = bigint).
   */
  private async namesFrom<T extends string | number>(
    table: 'profiles' | 'customers',
    ids: T[]
  ): Promise<Map<T, string>> {
    const result = new Map<T, string>();
    if (ids.length === 0) {
      return result;
    }

    const { data, error } = await this.db
      .from(table)
      .select('id, name')
      .in('id', ids)
      .returns<{ id: T; name: string | null }[]>();

    if (error) {
      throw error;
    }

    for (const row of data ?? []) {
      result.set(row.id, row.name ?? '');
    }
    return result;
  }
}

function unique<T extends string | number>(values: (T | null)[]): T[] {
  return [...new Set(values.filter((v): v is T => v !== null && v !== undefined))];
}

function deriveStatus(total: number, paid: number): SaleStatus {
  if (paid <= 0) {
    return 'pending';
  }
  if (paid + 0.01 >= total) {
    return 'paid';
  }
  return 'partial';
}
