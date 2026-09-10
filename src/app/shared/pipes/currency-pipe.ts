import { Pipe, PipeTransform } from '@angular/core';

const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0
});

/**
 * Formatea un número como pesos colombianos: 80000 -> "$ 80.000".
 * Sombrea a propósito al pipe `currency` de Angular para no repetir args.
 * Uso: {{ venta.total | currency }}
 */
@Pipe({ name: 'currency' })
export class CurrencyPipe implements PipeTransform {
  transform(value: number | string | null | undefined): string {
    const n = typeof value === 'string' ? Number(value) : value;
    if (n == null || Number.isNaN(n)) {
      return COP.format(0);
    }
    return COP.format(n);
  }
}
