/**
 * Fila de la tabla `categories` de Supabase.
 *   id (bigint identity), name, description, active, created_at
 */
export interface Category {
  id: number;
  name: string;
  description: string | null;
  active: boolean;
  created_at: string;
}

/** Campos editables de una categoría (crear / editar). */
export interface CategoryInput {
  name: string;
  description: string | null;
}
