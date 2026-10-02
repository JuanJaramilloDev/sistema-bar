import { inject } from '@angular/core';
import { CanMatchFn, RedirectCommand, Route, Router, UrlSegment } from '@angular/router';
import { Auth } from '../services/auth';

/**
 * Bloquea cualquier rama protegida si no hay sesión válida de Supabase.
 *
 * Se usa como `canMatch`: si falla, el chunk lazy ni siquiera se descarga y
 * la ruta cae al comodín. Redirige a /login guardando el destino en `redirect`.
 */
export const authGuard: CanMatchFn = async (
  _route: Route,
  segments: UrlSegment[]
): Promise<boolean | RedirectCommand> => {
  const auth = inject(Auth);
  const router = inject(Router);

  await auth.ensureLoaded();

  if (auth.isAuthenticated()) {
    return true;
  }

  const attempted = '/' + segments.map((s) => s.path).join('/');
  return new RedirectCommand(router.createUrlTree(['/login'], {
    queryParams: attempted && attempted !== '/' ? { redirect: attempted } : {}
  }), { skipLocationChange: true });
};
