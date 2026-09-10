import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Estado vacío / sin datos reutilizable.
 * Uso: <app-empty title="Todavía no hay ventas registradas" />
 */
@Component({
  selector: 'app-empty',
  imports: [],
  templateUrl: './empty.html',
  styleUrl: './empty.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Empty {
  readonly title = input('No hay información disponible');
  readonly hint = input('');
  /** Símbolo decorativo opcional. */
  readonly icon = input('—');
}
