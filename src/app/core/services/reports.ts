import { Injectable } from '@angular/core';

/**
 * Reportes administrativos (Fase 10). Los agregados del dashboard viven por
 * ahora en `Sales` e `Inventory`; cuando haya volumen real, las consultas
 * pesadas deberían moverse a vistas/RPC de Supabase y consumirse desde aquí.
 */
@Injectable({ providedIn: 'root' })
export class Reports {}
