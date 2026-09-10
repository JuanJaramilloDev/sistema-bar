/**
 * Fila de la tabla `customers` de Supabase.
 *   id (bigint identity), name, phone, notes, cuenta (numeric), created_at
 *
 * `cuenta` = saldo pendiente del cliente (lo que debe). Los abonos lo reducen.
 * Más adelante, la suma de los abonos de todos los clientes irá al reporte final.
 */
export interface Customer {
  id: number;
  name: string;
  phone: string | null;
  notes: string | null;
  cuenta: number;
  created_at: string;
}

/** Campos que se guardan de un cliente (crear / editar). `cuenta` en número. */
export interface CustomerInput {
  name: string;
  phone: string | null;
  notes: string | null;
  cuenta: number;
}
