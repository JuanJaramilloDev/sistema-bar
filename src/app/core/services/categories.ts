import { Injectable, inject } from '@angular/core';
import { Supabase, assertAffected } from './supabase';
import type { Category, CategoryInput } from '../models/category';

/**
 * Acceso a `categories`. Toda comunicación con Supabase pasa por aquí.
 *
 * Permisos: crear/editar/activar/eliminar solo administrador. El empleado solo
 * consulta. La barrera real es la RLS de Supabase; estos métodos no la sustituyen.
 *
 * Nombres duplicados: se recomienda un índice único en `lower(name)` en Supabase.
 * Si el INSERT/UPDATE choca con esa restricción, supabase-js devuelve code 23505
 * y la página muestra "Esta categoría ya existe."
 */
@Injectable({ providedIn: 'root' })
export class Categories {

  private readonly supabase = inject(Supabase);

  private get db() {
    return this.supabase.getClient();
  }

  private static readonly COLUMNS = 'id, name, description, active, created_at';

  /** Todas las categorías, ordenadas por nombre. */
  async list(): Promise<Category[]> {
    const { data, error } = await this.db
      .from('categories')
      .select(Categories.COLUMNS)
      .order('name', { ascending: true })
      .returns<Category[]>();

    if (error) {
      throw error;
    }
    return data ?? [];
  }

  async create(input: CategoryInput): Promise<Category> {
    const { data, error } = await this.db
      .from('categories')
      .insert({ name: input.name.trim(), description: nullable(input.description) })
      .select(Categories.COLUMNS)
      .single<Category>();

    if (error) {
      throw error;
    }
    return data;
  }

  async update(id: number, input: CategoryInput): Promise<Category> {
    const { data, error } = await this.db
      .from('categories')
      .update({ name: input.name.trim(), description: nullable(input.description) })
      .eq('id', id)
      .select(Categories.COLUMNS)
      .single<Category>();

    if (error) {
      throw error;
    }
    return data;
  }

  async setActive(id: number, active: boolean): Promise<void> {
    const { data, error } = await this.db
      .from('categories')
      .update({ active })
      .eq('id', id)
      .select('id');

    if (error) {
      throw error;
    }
    assertAffected(data, 'no se pudo cambiar el estado de la categoría');
  }

  /** Elimina la categoría. Falla (FK 23503) si tiene productos asociados. */
  async remove(id: number): Promise<void> {
    const { data, error } = await this.db
      .from('categories')
      .delete()
      .eq('id', id)
      .select('id');

    if (error) {
      throw error;
    }
    assertAffected(data, 'la categoría no se eliminó');
  }
}

function nullable(value: string | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length ? trimmed : null;
}
