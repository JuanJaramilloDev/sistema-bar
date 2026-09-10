import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  PLATFORM_ID
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

/**
 * Modal reutilizable. El contenido va por proyección (`<ng-content>`).
 *
 * Uso:
 *   <app-modal [open]="showForm()" title="Nueva categoría" (closed)="showForm.set(false)">
 *     ...formulario...
 *   </app-modal>
 */
@Component({
  selector: 'app-modal',
  imports: [],
  templateUrl: './modal.html',
  styleUrl: './modal.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'onEscape()'
  }
})
export class Modal {

  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly open = input(false);
  readonly title = input('');
  /** Impide cerrar tocando el fondo o Esc (útil mientras se guarda). */
  readonly locked = input(false);

  readonly closed = output<void>();

  constructor() {
    // Bloquea el scroll del fondo mientras el modal está abierto.
    effect(() => {
      if (!this.isBrowser) {
        return;
      }
      document.body.style.overflow = this.open() ? 'hidden' : '';
    });

    // Si se destruye el modal estando abierto, restaura el scroll.
    inject(DestroyRef).onDestroy(() => {
      if (this.isBrowser) {
        document.body.style.overflow = '';
      }
    });
  }

  onBackdrop(): void {
    if (!this.locked()) {
      this.closed.emit();
    }
  }

  onEscape(): void {
    if (this.open() && !this.locked()) {
      this.closed.emit();
    }
  }
}
