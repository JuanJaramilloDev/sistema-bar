import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { Navbar } from '../navbar/navbar';
import { Sidebar } from '../sidebar/sidebar';

/**
 * Contenedor común de las áreas autenticadas (/admin y /employee).
 * Compone sidebar + navbar + contenido y no se duplica en cada página.
 *
 * El sidebar/navbar deciden su contenido a partir del rol (`Auth`); este
 * componente solo maneja el estado del menú offcanvas en pantallas pequeñas.
 */
@Component({
  selector: 'app-layout',
  imports: [RouterOutlet, Navbar, Sidebar],
  templateUrl: './layout.html',
  styleUrl: './layout.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Layout {

  private readonly router = inject(Router);

  readonly menuOpen = signal(false);

  constructor() {
    // Al navegar, cierra el menú móvil.
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed()
      )
      .subscribe(() => this.menuOpen.set(false));
  }

  toggleMenu(): void {
    this.menuOpen.update((v) => !v);
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }
}
