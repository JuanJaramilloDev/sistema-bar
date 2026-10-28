import {
  DestroyRef,
  Directive,
  ElementRef,
  afterNextRender,
  inject
} from '@angular/core';

/** Ancho máximo (px) en el que la tabla pasa a tarjetas desplegables. */
const MOBILE_QUERY = '(max-width: 640px)';

/** Elementos que tienen su propio clic: tocarlos no despliega la fila. */
const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"]';

/**
 * Tablas sin scroll horizontal en el celular.
 *
 * Se aplica sola a toda `<table class="table">` del componente que la importe.
 * En pantallas angostas (ver `styles.css`, bloque "Tablas en celular") cada fila
 * se vuelve una tarjeta que muestra solo lo principal; al tocarla se despliega
 * el resto como "Etiqueta: valor". En escritorio la tabla se ve igual que antes.
 *
 * Qué se ve sin desplegar:
 *  - Por defecto: la primera columna + la primera numérica (`th.num`). Si no hay
 *    numérica, la primera + la segunda. Tablas de hasta 3 columnas se ven completas.
 *  - Si algún `<th>` tiene la clase `m-keep`, se ven exactamente esas columnas
 *    (la primera marcada es la principal).
 *
 * Las filas con una celda `colspan` (detalle desplegado, totales) ocupan todo
 * el ancho y no se pliegan.
 */
@Directive({
  selector: 'table.table',
  host: {
    class: 'rt',
    '(click)': 'onClick($event)'
  }
})
export class ResponsiveTable {

  private readonly table = inject<ElementRef<HTMLTableElement>>(ElementRef).nativeElement;
  private queued = false;

  constructor() {
    // Solo en el navegador (con SSR no existen `window` ni MutationObserver).
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      this.decorate();
      const observer = new MutationObserver(() => this.schedule());
      observer.observe(this.table, { childList: true, subtree: true });
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  onClick(event: MouseEvent): void {
    if (!window.matchMedia(MOBILE_QUERY).matches) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest(INTERACTIVE)) {
      return;
    }
    const row = target.closest('tr');
    if (row && row.classList.contains('rt-foldable') && this.table.contains(row)) {
      row.classList.toggle('rt-open');
    }
  }

  /** Agrupa los cambios del DOM (filas nuevas de un @for) en una sola pasada. */
  private schedule(): void {
    if (this.queued) {
      return;
    }
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.decorate();
    });
  }

  private decorate(): void {
    const headers = Array.from(this.table.tHead?.rows[0]?.cells ?? []);
    const labels = headers.map((th) => th.textContent?.trim() ?? '');
    const visible = this.visibleColumns(headers);

    const bodies = [...Array.from(this.table.tBodies), this.table.tFoot].filter(
      (b): b is HTMLTableSectionElement => b !== null
    );
    for (const body of bodies) {
      for (const row of Array.from(body.rows)) {
        this.decorateRow(row, labels, visible, body === this.table.tFoot);
      }
    }
  }

  private decorateRow(
    row: HTMLTableRowElement,
    labels: string[],
    visible: number[],
    isFoot: boolean
  ): void {
    const cells = Array.from(row.cells);
    const spans = cells.some((c) => c.colSpan > 1);

    // Detalle desplegado o fila de totales: ancho completo, sin plegar.
    if (spans || isFoot) {
      row.classList.add('rt-full');
      row.classList.remove('rt-foldable');
      cells.forEach((c) => c.classList.remove('rt-main', 'rt-keep', 'rt-extra'));
      return;
    }

    const main = visible[0];
    let foldable = false;
    cells.forEach((cell, i) => {
      cell.dataset['label'] = labels[i] ?? '';
      const shown = visible.includes(i);
      cell.classList.toggle('rt-main', i === main);
      cell.classList.toggle('rt-keep', shown && i !== main);
      const extra = !shown;
      cell.classList.toggle('rt-extra', extra);
      foldable ||= extra;
    });
    row.classList.remove('rt-full');
    row.classList.toggle('rt-foldable', foldable);
  }

  /** Índices de las columnas visibles sin desplegar; la primera es la principal. */
  private visibleColumns(headers: HTMLTableCellElement[]): number[] {
    const all = headers.map((_, i) => i);
    const marked = all.filter((i) => headers[i].classList.contains('m-keep'));
    if (marked.length > 0) {
      return marked;
    }
    if (headers.length <= 3) {
      return all;
    }
    const firstNum = all.find((i) => i > 0 && headers[i].classList.contains('num'));
    return [0, firstNum ?? 1];
  }
}
