/**
 * Roles del sistema. No hay multiempresa: un solo bar por proyecto.
 */
export type UserRole = 'admin' | 'employee';

/**
 * Fila de la tabla `profiles` de Supabase.
 *   id (uuid, = auth.users.id), name, email, role, active, created_at
 */
export interface Profile {
  id: string;
  email: string | null;
  name: string | null;
  role: UserRole;
  active: boolean;
  created_at: string;
}

/**
 * Datos para dar de alta un empleado. El usuario de Supabase Auth se crea en
 * una Edge Function con service_role (Angular nunca tiene esa clave).
 */
export interface NewEmployee {
  name: string;
  email: string;
  password: string;
}
