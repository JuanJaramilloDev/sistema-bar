import { Injectable, inject } from '@angular/core';
import { Supabase, assertAffected } from './supabase';
import type {
  Product,
  ProductCatalogItem,
  ProductInput,
  ProductRow
} from '../models/product';

/**
 * Acceso a `products`. Toda comunicación con Supabase pasa por aquí.
 *
 * Permisos: crear/editar/activar/eliminar y ver `cost_price` solo administrador.
 * `list()` incluye `cost_price` (uso admin). `catalog()` lo excluye (uso ventas).
 *
 * SEGURIDAD DEL COSTO: excluir la columna en `catalog()` es solo defensa en
 * profundidad. La garantía real de que un empleado no lea `products.cost_price`
 * debe venir de Supabase (ver notas de la fase). Si la RLS/grants actuales
 * dejan que un empleado lo consulte, hay que corregirlo en la base de datos.
 */
@Injectable({ providedIn: 'root' })
export class Products {

  private readonly supabase = inject(Supabase);

  private get db() {
    return this.supabase.getClient();
  }

  private static readonly ADMIN_COLUMNS =
    'id, category_id, name, description, sale_price, cost_price, minimum_stock, image, active, created_at, updated_at';

  /** Listado completo para el administrador (incluye costo y nombre de categoría). */
  async list(): Promise<ProductRow[]> {
    const { data, error } = await this.db
      .from('products')
      .select(`${Products.ADMIN_COLUMNS}, categories(name)`)
      .order('name', { ascending: true })
      .returns<(Product & { categories: { name: string } | null })[]>();

    if (error) {
      throw error;
    }

    return (data ?? []).map(({ categories, ...product }) => ({
      ...product,
      category_name: categories?.name ?? null
    }));
  }

  /**
   * Catálogo para ventas (empleado): SIN `cost_price`, solo productos activos.
   */
  async catalog(): Promise<ProductCatalogItem[]> {
    const { data, error } = await this.db
      .from('products')
      .select('id, category_id, name, description, sale_price, minimum_stock, image, active')
      .eq('active', true)
      .order('name', { ascending: true })
      .returns<ProductCatalogItem[]>();

    if (error) {
      throw error;
    }
    return data ?? [];
  }

  async create(input: ProductInput): Promise<Product> {
    const { data, error } = await this.db
      .from('products')
      .insert(toRow(input))
      .select(Products.ADMIN_COLUMNS)
      .single<Product>();

    if (error) {
      throw error;
    }
    return data;
  }

  async update(id: number, input: ProductInput): Promise<Product> {
    const { data, error } = await this.db
      .from('products')
      .update({ ...toRow(input), updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(Products.ADMIN_COLUMNS)
      .single<Product>();

    if (error) {
      throw error;
    }
    return data;
  }

  async setActive(id: number, active: boolean): Promise<void> {
    const { data, error } = await this.db
      .from('products')
      .update({ active, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id');

    if (error) {
      throw error;
    }
    assertAffected(data, 'no se pudo cambiar el estado del producto');
  }

  /** Elimina el producto. Puede fallar (FK) si tiene inventario o ventas asociadas. */
  async remove(id: number): Promise<void> {
    const { data, error } = await this.db
      .from('products')
      .delete()
      .eq('id', id)
      .select('id');

    if (error) {
      throw error;
    }
    assertAffected(data, 'el producto no se eliminó');
  }
}

/** Normaliza la entrada del formulario a tipos correctos para la base de datos. */
function toRow(input: ProductInput): {
  category_id: number;
  name: string;
  description: string | null;
  sale_price: number;
  cost_price: number;
  minimum_stock: number;
  image: string | null;
} {
  return {
    category_id: Number(input.category_id),
    name: input.name.trim(),
    description: nullable(input.description),
    sale_price: Number(input.sale_price),
    cost_price: Number(input.cost_price),
    minimum_stock: Math.trunc(Number(input.minimum_stock)),
    image: nullable(input.image)
  };
}

function nullable(value: string | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length ? trimmed : null;
}
