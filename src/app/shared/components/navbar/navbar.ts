import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal
} from '@angular/core';
import { Router } from '@angular/router';
import { Auth } from '../../../core/services/auth';
import { LastRoute } from '../../../core/services/last-route';

/**
 * Barra superior. Muestra el nombre del sistema, el usuario actual y su rol,
 * el botón de cerrar sesión (usa el servicio `Auth` existente) y, en pantallas
 * pequeñas, el botón para abrir/cerrar el sidebar.
 */
@Component({
  selector: 'app-navbar',
  imports: [],
  templateUrl: './navbar.html',
  styleUrl: './navbar.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Navbar {

  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly lastRoute = inject(LastRoute);

  /** Pide al layout abrir/cerrar el sidebar (solo relevante en móvil/tablet). */
  readonly menuToggle = output<void>();

  protected readonly name = this.auth.displayName;
  protected readonly roleLabel = computed(() =>
    this.auth.role() === 'admin' ? 'Administrador' : 'Empleado'
  );
  protected readonly loggingOut = signal(false);

  async logout(): Promise<void> {
    if (this.loggingOut()) {
      return;
    }
    this.loggingOut.set(true);
    this.lastRoute.clear();
    try {
      await this.auth.signOut();
      await this.router.navigateByUrl('/login', { skipLocationChange: true });
    } catch {
      // signOut local no debería fallar; si lo hace, forzamos ir al login.
      await this.router.navigateByUrl('/login', { skipLocationChange: true });
    } finally {
      this.loggingOut.set(false);
    }
  }
}
