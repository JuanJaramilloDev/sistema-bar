import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Estado de carga reutilizable.
 * Uso: <app-loading message="Cargando ventas…" />
 */
@Component({
  selector: 'app-loading',
  imports: [],
  templateUrl: './loading.html',
  styleUrl: './loading.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Loading {
  readonly message = input('Cargando…');
  /** 'block' ocupa alto propio (secciones); 'inline' va dentro de una fila. */
  readonly variant = input<'block' | 'inline'>('block');
}
