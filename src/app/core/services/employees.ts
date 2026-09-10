import { Injectable, inject } from '@angular/core';
import { Supabase } from './supabase';
import type { NewEmployee, Profile } from '../models/user';

/**
 * Gestión de empleados = filas de `profiles`.
 *
 * - Listar / renombrar / activar-desactivar: consultas normales sobre `profiles`
 *   (la RLS de Supabase permite al admin ver y editar `name`/`active`).
 * - Crear un usuario employee: NO se puede desde Angular (requiere service_role).
 *   Se delega en la Edge Function `create-employee`, que verifica que quien
 *   llama es admin y crea el usuario en Supabase Auth + su perfil.
 *
 * SEGURIDAD: Angular nunca cambia `role` ni `id`. Esas columnas están revocadas
 * para `authenticated` en Supabase; un cambio de rol necesitaría una función
 * dedicada (fuera de esta fase).
 */
@Injectable({ providedIn: 'root' })
export class Employees {

  private readonly supabase = inject(Supabase);

  private get db() {
    return this.supabase.getClient();
  }

  /** Todos los perfiles (admin + empleados), ordenados por nombre. */
  async list(): Promise<Profile[]> {
    const { data, error } = await this.db
      .from('profiles')
      .select('id, name, email, role, active, created_at')
      .order('name', { ascending: true })
      .returns<Profile[]>();

    if (error) {
      throw error;
    }
    return data ?? [];
  }

  /** Crea el usuario employee vía Edge Function. Lanza `EmployeeError` con un código. */
  async create(input: NewEmployee): Promise<Profile> {
    const { data, error } = await this.db.functions.invoke<Profile>(
      'create-employee',
      {
        body: {
          name: input.name.trim(),
          email: input.email.trim().toLowerCase(),
          password: input.password
        }
      }
    );

    if (error) {
      throw await toEmployeeError(error);
    }
    if (!data) {
      throw new EmployeeError('UNEXPECTED');
    }
    return data;
  }

  async rename(id: string, name: string): Promise<void> {
    const { error } = await this.db
      .from('profiles')
      .update({ name: name.trim() })
      .eq('id', id);

    if (error) {
      throw error;
    }
  }

  async setActive(id: string, active: boolean): Promise<void> {
    const { error } = await this.db
      .from('profiles')
      .update({ active })
      .eq('id', id);

    if (error) {
      throw error;
    }
  }
}

/** Error de la Edge Function de creación, con un código estable. */
export class EmployeeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'EmployeeError';
  }
}

async function toEmployeeError(error: unknown): Promise<EmployeeError> {
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.json()) as { error?: string };
      if (body?.error) {
        return new EmployeeError(body.error);
      }
    } catch {
      /* respuesta sin cuerpo JSON */
    }
  }
  return new EmployeeError('UNEXPECTED');
}
