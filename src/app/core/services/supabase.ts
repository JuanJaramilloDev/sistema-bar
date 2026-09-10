import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../../environments/environment';

/**
 * Único punto de creación del cliente de Supabase.
 * El resto de servicios (auth, products, sales, ...) lo obtienen desde aquí
 * con `getClient()` y nunca crean su propia instancia.
 */
@Injectable({
  providedIn: 'root'
})
export class Supabase {

  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly client: SupabaseClient = createClient(
    environment.supabaseUrl,
    environment.supabaseKey,
    {
      auth: {
        // La sesión solo se persiste/refresca en el navegador.
        // En SSR no hay localStorage: evitamos que supabase-js falle.
        persistSession: this.isBrowser,
        autoRefreshToken: this.isBrowser,
        detectSessionInUrl: this.isBrowser,
        storageKey: 'sistema-bar.auth'
      }
    }
  );

  getClient(): SupabaseClient {
    return this.client;
  }
}

/** Error de PostgREST/Postgres tal como lo entrega supabase-js. */
export interface DbError {
  code?: string;
  message?: string;
  details?: string | null;
}

/**
 * Traduce un error de Supabase a un mensaje entendible para el usuario.
 * Nunca se muestra el mensaje técnico; ese va a `console.error` en el llamador.
 */
export function humanizeDbError(
  error: DbError | null | undefined,
  fallback = 'No fue posible completar la operación.'
): string {
  if (!error) {
    return fallback;
  }
  switch (error.code) {
    case 'NO_ROWS': // la escritura no afectó ninguna fila (típico: RLS la bloqueó)
      return 'No se pudo completar: no tienes permiso para esta acción o el registro ya no existe.';
    case '23505': // unique_violation
      return 'Ya existe un registro con ese nombre.';
    case '23503': // foreign_key_violation
      return 'No se puede completar: hay otros registros que dependen de este.';
    case '23514': // check_violation
      return 'Alguno de los valores no cumple las reglas del sistema.';
    case '23502': // not_null_violation
      return 'Faltan datos obligatorios.';
    case '42501': // insufficient_privilege (RLS / grants)
      return 'No tienes permisos para realizar esta acción.';
    case 'PGRST301': // JWT expirado
      return 'Tu sesión expiró. Vuelve a iniciar sesión.';
  }
  if (/duplicate key|already exists/i.test(error.message ?? '')) {
    return 'Ya existe un registro con ese nombre.';
  }
  if (/row-level security|permission denied/i.test(error.message ?? '')) {
    return 'No tienes permisos para realizar esta acción.';
  }
  if (/failed to fetch|networkerror/i.test(error.message ?? '')) {
    return 'Sin conexión con el servidor. Revisa tu internet.';
  }
  return fallback;
}

/**
 * PostgREST no devuelve error cuando un UPDATE/DELETE no toca ninguna fila
 * (p. ej. porque una política RLS lo filtra). Sin esto, la app creería que la
 * operación tuvo éxito. Se llama con el `data` de un `.select()` encadenado.
 */
export function assertAffected(
  rows: unknown[] | null | undefined,
  detail = 'la operación no afectó ninguna fila'
): void {
  if (!rows || rows.length === 0) {
    const err: DbError = { code: 'NO_ROWS', message: detail };
    throw err;
  }
}
