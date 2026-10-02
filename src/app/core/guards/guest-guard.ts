import { inject } from '@angular/core';
import { CanMatchFn, RedirectCommand, Router } from '@angular/router';
import { Auth } from '../services/auth';
import { LastRoute } from '../services/last-route';

/**
 * Protege el login: si ya hay sesión válida, ni siquiera se renderiza y se va
 * directo a la última pantalla visitada (o al inicio del rol). Evita el
 * "flash" del login al recargar la página.
 */
export const guestGuard: CanMatchFn = async (): Promise<boolean | RedirectCommand> => {
  const auth = inject(Auth);
  const router = inject(Router);
  const lastRoute = inject(LastRoute);

  await auth.ensureLoaded();

  if (!auth.isAuthenticated() || !auth.role() || !auth.isActive()) {
    return true;
  }

  const home = auth.isAdmin() ? '/admin' : '/employee';
  const last = lastRoute.get();
  const target = last && last.startsWith(home) ? last : home;
  return new RedirectCommand(router.parseUrl(target), { skipLocationChange: true });
};
