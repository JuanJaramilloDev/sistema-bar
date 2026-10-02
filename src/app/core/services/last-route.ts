import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

const KEY = 'lastRoute';

/**
 * Recuerda la última pantalla visitada (en `sessionStorage`, por pestaña).
 *
 * La app navega con `skipLocationChange`, así que la barra de direcciones no
 * guarda la ruta. Este servicio la guarda aparte para que, al recargar, el
 * login pueda devolver al usuario a la misma pantalla.
 */
@Injectable({ providedIn: 'root' })
export class LastRoute {

  private readonly router = inject(Router);

  /** Empieza a guardar cada navegación del área privada. Se llama una vez al arrancar. */
  track(): void {
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        const url = e.urlAfterRedirects;
        if (url.startsWith('/admin') || url.startsWith('/employee')) {
          this.write(url);
        }
      });
  }

  get(): string | null {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  /** Al cerrar sesión, para que el siguiente usuario empiece en su inicio. */
  clear(): void {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      // Sin storage disponible no hay nada que borrar.
    }
  }

  private write(url: string): void {
    try {
      sessionStorage.setItem(KEY, url);
    } catch {
      // Sin storage (modo privado/bloqueado): simplemente no se recuerda.
    }
  }
}
