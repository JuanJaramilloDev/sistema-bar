/**
 * Modelos de inventario.
 *
 * Tablas (Supabase). Todos los id son `bigint identity` salvo `user_id` (uuid):
 *   inventory           : id, product_id, quantity, updated_at
 *   inventory_movements : id, product_id, type, quantity, previous_quantity,
 *                         new_quantity, user_id (uuid), sale_id, reason, created_at
 *
 * Angular NUNCA escribe estas tablas directamente: las operaciones que cambian
 * stock se hacen con RPC de Postgres (ver core/services/inventory.ts).
 * El stock mínimo vive en `products.minimum_stock`.
 */

export type StockStatus = 'out' | 'low' | 'ok';

/**
 * Estado de stock:
 *   sin stock  -> quantity = 0
 *   bajo       -> 0 < quantity <= minimum_stock
 *   normal     -> quantity > minimum_stock
 */
export function stockStatus(quantity: number, minimum: number): StockStatus {
  if (quantity <= 0) {
    return 'out';
  }
  if (quantity <= minimum) {
    return 'low';
  }
  return 'ok';
}

/** Fila reducida de inventario (usada por los dashboards para alertas). */
export interface InventoryItem {
  productId: number;
  productName: string;
  quantity: number;
  minimumStock: number;
  status: StockStatus;
}

/** Fila completa para el módulo de inventario. */
export interface InventoryRow {
  productId: number;
  productName: string;
  productImage: string | null;
  productActive: boolean;
  categoryId: number | null;
  categoryName: string | null;
  quantity: number;
  minimumStock: number;
  status: StockStatus;
  updatedAt: string | null;
}

export type MovementType = 'entry' | 'sale' | 'adjustment' | 'return';

/** Movimiento de inventario ya resuelto para pintar en el historial. */
export interface StockMovement {
  id: number;
  productId: number;
  productName: string;
  type: MovementType;
  quantity: number;
  previousQuantity: number;
  newQuantity: number;
  reason: string | null;
  userName: string | null;
  createdAt: string;
}

/** Resultado que devuelven las RPC de inventario. */
export interface InventoryOperationResult {
  previousQuantity: number;
  newQuantity: number;
}
