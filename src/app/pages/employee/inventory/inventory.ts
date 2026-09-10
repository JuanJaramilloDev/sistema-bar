/**
 * Inventario del empleado = MISMA pantalla que la del administrador, en modo
 * solo lectura. El componente oculta las acciones y la pestaña de movimientos
 * cuando el rol no es `admin`, y la seguridad real la imponen el roleGuard, la
 * RLS de Supabase y el `is_admin()` dentro de cada RPC.
 *
 * Se reexporta para no duplicar la vista. Los `inventory.html` / `inventory.css`
 * de esta carpeta quedaron sin uso (se conservan por convención del proyecto).
 */
export { Inventory } from '../../admin/inventory/inventory';
