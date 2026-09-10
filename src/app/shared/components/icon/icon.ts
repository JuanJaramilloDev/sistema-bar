import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Trazos de iconos (estilo Lucide, viewBox 0 0 24 24, stroke).
 * Cada valor es el contenido de uno o varios `<path d="…">`.
 */
const PATHS: Record<string, string[]> = {
  edit: [
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    'm15 5 4 4'
  ],
  trash: [
    'M3 6h18',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    'M10 11v6',
    'M14 11v6'
  ],
  plus: ['M5 12h14', 'M12 5v14'],
  power: ['M12 2v10', 'M18.36 6.64a9 9 0 1 1-12.73 0'],
  sliders: [
    'M21 4h-7', 'M10 4H3', 'M21 12h-9', 'M8 12H3', 'M21 20h-5', 'M12 20H3',
    'M14 2v4', 'M8 10v4', 'M16 18v4'
  ],
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11']
};

/**
 * Icono SVG reutilizable. Toma el color del texto y escala con el `font-size`.
 * Uso: <app-icon name="edit" />
 */
@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      @for (d of paths(); track $index) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
  styles: `
    :host { display: inline-flex; line-height: 0; }
    svg { width: 1.05em; height: 1.05em; }
  `
})
export class Icon {
  readonly name = input.required<string>();
  protected readonly paths = computed(() => PATHS[this.name()] ?? []);
}
