/**
 * Roles del sistema. No hay multiempresa: un solo bar por proyecto.
 */
export type UserRole = 'admin' | 'employee';

/**
 * Fila de la tabla `profiles` de Supabase.
 *   id (uuid, = auth.users.id), name, email, role, active, created_at
 *
 * `active` (boolean, default true): desactivar a un empleado NO borra nada
 * de lo que hizo (ventas, movimientos de inventario) — solo le impide volver
 * a entrar. Lo aplica `roleGuard` (y el login) comprobando `active === false`
 * y cerrando la sesión. Ver `supabase/sql/setup-completo.sql` (sección 7).
 *
 * SEGURIDAD: esto es un candado de navegación, igual que el resto de `role()`.
 * Una sesión YA abierta (token todavía válido) no se corta al instante si se
 * desactiva a alguien a mitad de turno: se corta en su próximo login o
 * recarga completa de la página, porque el perfil se cachea en memoria
 * mientras dura la pestaña. Si se necesita corte inmediato, haría falta RLS
 * adicional o una suscripción en tiempo real a `profiles` (no implementado).
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
