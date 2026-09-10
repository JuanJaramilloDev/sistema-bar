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
 * - Rol equivocado -> se le envía a SU propia área, nunca entra a la ajena.
 *
 * Esto NO sustituye a RLS: aunque alguien fuerce la navegación, Supabase debe
 * seguir negando los datos que no le corresponden.
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

  const required = route.data?.['role'] as UserRole | UserRole[] | undefined;
  const allowed = Array.isArray(required) ? required : required ? [required] : [];

  if (allowed.length === 0 || allowed.includes(role)) {
    return true;
  }

  return router.createUrlTree([role === 'admin' ? '/admin' : '/employee']);
};
