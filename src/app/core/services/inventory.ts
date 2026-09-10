import { Injectable, inject } from '@angular/core';
import { Supabase } from './supabase';
import {
  InventoryItem,
  InventoryOperationResult,
  InventoryRow,
  MovementType,
  StockMovement,
  stockStatus
} from '../models/inventory';

/**
 * Inventario.
 *
 * LECTURA: consultas normales (RLS decide el alcance; empleado y admin pueden
 * ver existencias, solo el admin ve el historial de movimientos).
 *
 * ESCRITURA: Angular NUNCA toca `inventory` ni `inventory_movements`. Cada
 * operación que cambia stock llama a una RPC de Postgres que, en una sola
 * transacción: valida admin (auth.uid), bloquea la fila, actualiza `inventory`
 * y registra el movimiento. Si algo falla, rollback completo.
 *
 *   Angular → inventory.ts → supabase.rpc(...) → PostgreSQL
 *
 * RPC usadas: add_inventory_entry, adjust_inventory, return_inventory
 * (SQL en las notas de la Fase 4).
 */
@Injectable({ providedIn: 'root' })
export class Inventory {

  private readonly supabase = inject(Supabase);

  private get db() {
    return this.supabase.getClient();
  }

  // ---------------------------------------------------------------- lecturas ---

  /** Inventario completo (producto + categoría + existencia). */
  async list(): Promise<InventoryRow[]> {
    const { data, error } = await this.db
      .from('inventory')
      .select(
        'product_id, quantity, updated_at, ' +
          'products(name, image, minimum_stock, active, category_id, categories(name))'
      )
      .returns<
        {
          product_id: number;
          quantity: number | null;
          updated_at: string | null;
          products: {
            name: string;
            image: string | null;
            minimum_stock: number | null;
            active: boolean | null;
            category_id: number | null;
            categories: { name: string } | null;
          } | null;
        }[]
      >();

    if (error) {
      throw error;
    }

    return (data ?? [])
      .map((row) => {
        const quantity = row.quantity ?? 0;
        const minimum = row.products?.minimum_stock ?? 0;
        return {
          productId: row.product_id,
          productName: row.products?.name ?? 'Producto',
          productImage: row.products?.image ?? null,
          productActive: row.products?.active ?? true,
          categoryId: row.products?.category_id ?? null,
          categoryName: row.products?.categories?.name ?? null,
          quantity,
          minimumStock: minimum,
          status: stockStatus(quantity, minimum),
          updatedAt: row.updated_at
        } satisfies InventoryRow;
      })
      .sort((a, b) => a.productName.localeCompare(b.productName));
  }

  /**
   * Productos en el mínimo o por debajo (para alertas del dashboard).
   * Consulta propia y ligera para no acoplar los dashboards a `list()`.
   */
  async lowStock(limit = 200): Promise<InventoryItem[]> {
    const { data, error } = await this.db
      .from('inventory')
      .select('product_id, quantity, products(name, minimum_stock)')
      .returns<
        {
          product_id: number;
          quantity: number | null;
          products: { name: string; minimum_stock: number | null } | null;
        }[]
      >();

    if (error) {
      throw error;
    }

    return (data ?? [])
      .map((row) => {
        const quantity = row.quantity ?? 0;
        const minimum = row.products?.minimum_stock ?? 0;
        return {
          productId: row.product_id,
          productName: row.products?.name ?? 'Producto',
          quantity,
          minimumStock: minimum,
          status: stockStatus(quantity, minimum)
        } satisfies InventoryItem;
      })
      .filter((item) => item.status !== 'ok')
      .sort((a, b) => a.quantity - b.quantity || a.productName.localeCompare(b.productName))
      .slice(0, limit);
  }

  /** Historial de movimientos (admin). Más recientes primero. */
  async movements(limit = 100): Promise<StockMovement[]> {
    const { data, error } = await this.db
      .from('inventory_movements')
      .select(
        'id, product_id, type, quantity, previous_quantity, new_quantity, reason, user_id, created_at, products(name)'
      )
      .order('created_at', { ascending: false })
      .limit(limit)
      .returns<
        {
          id: number;
          product_id: number;
          type: MovementType;
          quantity: number | null;
          previous_quantity: number | null;
          new_quantity: number | null;
          reason: string | null;
          user_id: string | null;
          created_at: string;
          products: { name: string } | null;
        }[]
      >();

    if (error) {
      throw error;
    }

    const rows = data ?? [];
    const userNames = await this.resolveUserNames(
      [...new Set(rows.map((r) => r.user_id).filter((v): v is string => !!v))]
    );

    return rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      productName: r.products?.name ?? 'Producto',
      type: r.type,
      quantity: r.quantity ?? 0,
      previousQuantity: r.previous_quantity ?? 0,
      newQuantity: r.new_quantity ?? 0,
      reason: r.reason,
      userName: r.user_id ? userNames.get(r.user_id) ?? null : null,
      createdAt: r.created_at
    }));
  }

  /**
   * Nombre por id de usuario (`inventory_movements.user_id` es uuid y coincide
   * con `profiles.id`). La columna del nombre en `profiles` es `name`.
   */
  private async resolveUserNames(userIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (userIds.length === 0) {
      return result;
    }

    const { data } = await this.db
      .from('profiles')
      .select('id, name')
      .in('id', userIds)
      .returns<{ id: string; name: string | null }[]>();

    for (const profile of data ?? []) {
      result.set(profile.id, profile.name ?? '');
    }
    return result;
  }

  // -------------------------------------------------- operaciones (vía RPC) ---

  /** Entrada de mercancía (+). Solo admin (validado en la RPC). */
  registerEntry(
    productId: number,
    quantity: number,
    reason: string | null
  ): Promise<InventoryOperationResult> {
    return this.callOperation('add_inventory_entry', {
      p_product_id: Number(productId),
      p_quantity: Math.trunc(Number(quantity)),
      p_reason: normalizeReason(reason)
    });
  }

  /** Ajuste a un conteo físico (±). Motivo obligatorio. Solo admin. */
  adjust(
    productId: number,
    countedQuantity: number,
    reason: string
  ): Promise<InventoryOperationResult> {
    return this.callOperation('adjust_inventory', {
      p_product_id: Number(productId),
      p_counted_quantity: Math.trunc(Number(countedQuantity)),
      p_reason: normalizeReason(reason)
    });
  }

  /** Devolución que vuelve al inventario (+). Motivo obligatorio. Solo admin. */
  registerReturn(
    productId: number,
    quantity: number,
    reason: string
  ): Promise<InventoryOperationResult> {
    return this.callOperation('return_inventory', {
      p_product_id: Number(productId),
      p_quantity: Math.trunc(Number(quantity)),
      p_reason: normalizeReason(reason)
    });
  }

  private async callOperation(
    fn: 'add_inventory_entry' | 'adjust_inventory' | 'return_inventory',
    params: Record<string, unknown>
  ): Promise<InventoryOperationResult> {
    const { data, error } = await this.db.rpc(fn, params);

    if (error) {
      throw error;
    }

    const result = data as {
      previous_quantity?: number;
      new_quantity?: number;
    } | null;

    return {
      previousQuantity: Number(result?.previous_quantity ?? 0),
      newQuantity: Number(result?.new_quantity ?? 0)
    };
  }
}

function normalizeReason(reason: string | null): string | null {
  const trimmed = (reason ?? '').trim();
  return trimmed.length ? trimmed : null;
}
