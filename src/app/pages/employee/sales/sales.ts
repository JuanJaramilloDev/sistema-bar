/**
 * Ventas del empleado = MISMA pantalla que la del administrador. El componente
 * se adapta al rol y la seguridad real la imponen el roleGuard, la RLS de
 * Supabase y la RPC `create_sale` (que toma el empleado de `auth.uid()`).
 *
 * Se reexporta para no duplicar la vista. Los `sales.html` / `sales.css` de
 * esta carpeta quedaron sin uso (se conservan por convención del proyecto).
 */
export { Sales } from '../../admin/sales/sales';
