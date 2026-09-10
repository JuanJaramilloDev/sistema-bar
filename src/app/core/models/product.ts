/**
 * Fila de la tabla `products` de Supabase.
 *   id (bigint identity), category_id (bigint -> categories.id), name, description,
 *   sale_price, cost_price, minimum_stock, image, active, created_at, updated_at
 *
 * `cost_price` es información administrativa. NO debe llegar al empleado.
 * Para consultas de empleado/ventas se usa `ProductCatalogItem` (sin costo)
 * y, sobre todo, la protección real en Supabase (ver notas de la fase).
 */
export interface Product {
  id: number;
  category_id: number | null;
  name: string;
  description: string | null;
  sale_price: number;
  cost_price: number;
  minimum_stock: number;
  image: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Producto + nombre de su categoría, para el listado del administrador. */
export interface ProductRow extends Product {
  category_name: string | null;
}

/** Campos editables de un producto (crear / editar). Todo tipado como número. */
export interface ProductInput {
  category_id: number;
  name: string;
  description: string | null;
  sale_price: number;
  cost_price: number;
  minimum_stock: number;
  image: string | null;
}

/**
 * Vista de producto SIN datos administrativos (sin `cost_price`).
 * Pensada para el catálogo de ventas (empleado). Defensa en profundidad:
 * la garantía real de que el empleado no ve el costo debe estar en Supabase.
 */
export interface ProductCatalogItem {
  id: number;
  category_id: number | null;
  name: string;
  description: string | null;
  sale_price: number;
  minimum_stock: number;
  image: string | null;
  active: boolean;
}
