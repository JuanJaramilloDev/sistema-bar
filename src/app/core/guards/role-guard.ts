import { inject } from '@angular/core';
import { CanMatchFn, Route, Router, UrlTree } from '@angular/router';
import { Auth } from '../services/auth';
import type { UserRole } from '../models/user';

/**
 * Restringe una rama a uno o varios roles. El rol requerido se declara en
 * `data.role` de la ruta (`'admin'`, `'employee'` o un array).
 *
 * - Sin sesión -> lo resuelve antes `authGuard`.
 * - Sesión pero sin perfil/rol -> fuera (posible fallo de RLS en `profiles`).
 * - Perfil desactivado (`active = false`) -> fuera, y se cierra la sesión.
 * - Rol equivocado -> se le envía a SU propia área, nunca entra a la ajena.
 *
 * Esto NO sustituye a RLS: aunque alguien fuerce la navegación, Supabase debe
 * seguir negando los datos que no le corresponden.
 *
 * LÍMITE conocido: el perfil se cachea en memoria mientras dura la pestaña
 * (`ensureLoaded()` no lo vuelve a pedir si ya lo tiene). Si a alguien lo
 * desactivan mientras ya tiene la app abierta, este guard no lo saca al
 * instante — lo hace en su próxima navegación tras recargar la página o en
 * su próximo login. No hay suscripción en tiempo real a `profiles` para
 * cortar la sesión de inmediato.
 */
export const roleGuard: CanMatchFn = async (
  route: Route
): Promise<boolean | UrlTree> => {
  const auth = inject(Auth);
  const router = inject(Router);

  await auth.ensureLoaded();

  const role = auth.role();
  if (!role) {
    return router.createUrlTree(['/login'], {
      queryParams: { reason: 'no-profile' }
    });
  }

  if (!auth.isActive()) {
    await auth.signOut();
    return router.createUrlTree(['/login'], {
      queryParams: { reason: 'disabled' }
    });
  }

  const required = route.data?.['role'] as UserRole | UserRole[] | undefined;
  const allowed = Array.isArray(required) ? required : required ? [required] : [];

  if (allowed.length === 0 || allowed.includes(role)) {
    return true;
  }

  return router.createUrlTree([role === 'admin' ? '/admin' : '/employee']);
};
