import { Injectable, WritableSignal, inject, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { Supabase } from './supabase';

/**
 * Avisos en tiempo real de Supabase Realtime (Postgres Changes): una venta o
 * un abono hecho en un dispositivo debe aparecer en los demás que tengan
 * sesión abierta, sin que nadie tenga que refrescar.
 *
 * Esto NO reemplaza ninguna seguridad: Realtime respeta las mismas políticas
 * RLS de SELECT de cada tabla, así que una sesión solo recibe avisos de lo
 * que ya podría leer por su cuenta (un empleado no se entera de ventas ajenas
 * de otros días, por ejemplo).
 *
 * Las páginas NO reciben las filas por el socket: solo un contador ("tick")
 * que sube con cada cambio. Cada página reacciona pidiendo sus datos de
 * nuevo a Supabase, que sigue siendo la única fuente de verdad.
 *
 * Requiere que las tablas estén agregadas a la publicación `supabase_realtime`
 * en Supabase — ver `supabase/sql/fix-08-realtime.sql`.
 */
@Injectable({ providedIn: 'root' })
export class Realtime {

  private readonly supabase = inject(Supabase);
  private channel: RealtimeChannel | null = null;
  private readonly timers: Partial<Record<'sales' | 'inventory', ReturnType<typeof setTimeout>>> = {};

  /** Sube con cualquier cambio en ventas, sus líneas o sus pagos/abonos. */
  readonly salesTick = signal(0);
  /** Sube con cualquier cambio de existencias (una venta también las descuenta). */
  readonly inventoryTick = signal(0);

  constructor() {
    this.connect();
  }

  private connect(): void {
    if (this.channel) {
      return;
    }

    this.channel = this.supabase
      .getClient()
      .channel('db-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sales' },
        () => this.schedule('sales', this.salesTick)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sale_items' },
        () => this.schedule('sales', this.salesTick)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'payments' },
        () => this.schedule('sales', this.salesTick)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'inventory' },
        () => this.schedule('inventory', this.inventoryTick)
      )
      .subscribe();
  }

  /**
   * Agrupa varios avisos casi simultáneos (una venta cambia `sales` +
   * `sale_items` + `payments` + `inventory` a la vez) en un solo tick, para
   * no disparar la misma recarga 3 o 4 veces seguidas.
   */
  private schedule(key: 'sales' | 'inventory', tick: WritableSignal<number>): void {
    clearTimeout(this.timers[key]);
    this.timers[key] = setTimeout(() => tick.update((n) => n + 1), 400);
  }
}
