/**
 * Clientes del empleado = MISMA pantalla que la del administrador. El componente
 * se adapta al rol (el empleado no ve el botón de eliminar) y la RLS de Supabase
 * impone la seguridad real. Se reexporta para no duplicar la vista.
 */
export { Customers } from '../../admin/customers/customers';
