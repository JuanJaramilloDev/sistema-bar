import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { Auth } from '../../../core/services/auth';

interface NavItem {
  label: string;
  /** Ruta absoluta. Solo se enlaza si `ready` es true. */
  path: string;
  icon: string;
  /** false = módulo aún no construido (se muestra deshabilitado). */
  ready: boolean;
}

/** Trazos de iconos (viewBox 0 0 24 24, stroke). */
const ICONS: Record<string, string> = {
  grid: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z',
  cart: 'M6 6h15l-1.6 9H7.5zM6 6 5 3H2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2M18 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  users: 'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 20v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  box: 'M21 8 12 3 3 8l9 5 9-5ZM3 8v8l9 5 9-5V8M12 13v8',
  tag: 'M20 12 12 20 3 11V3h8zM7.5 7.5h.01',
  layers: 'M12 2l9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 17l9 5 9-5',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6',
  chart: 'M3 21h18M7 21V11M12 21V5M17 21v-7',
  userCheck: 'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8M16 11l2 2 4-4'
};

const ADMIN_NAV: NavItem[] = [
  { label: 'Dashboard', path: '/admin/dashboard', icon: 'grid', ready: true },
  { label: 'Ventas', path: '/admin/sales', icon: 'cart', ready: false },
  { label: 'Productos', path: '/admin/products', icon: 'tag', ready: true },
  { label: 'Categorías', path: '/admin/categories', icon: 'layers', ready: true },
  { label: 'Inventario', path: '/admin/inventory', icon: 'box', ready: true },
  { label: 'Facturas', path: '/admin/invoices', icon: 'file', ready: false },
  { label: 'Reportes', path: '/admin/reports', icon: 'chart', ready: false },
  { label: 'Empleados', path: '/admin/employees', icon: 'userCheck', ready: false },
  { label: 'Clientes', path: '/admin/customers', icon: 'users', ready: true }
];

const EMPLOYEE_NAV: NavItem[] = [
  { label: 'Dashboard', path: '/employee/dashboard', icon: 'grid', ready: true },
  { label: 'Ventas', path: '/employee/sales', icon: 'cart', ready: false },
  { label: 'Pendientes', path: '/employee/pending', icon: 'clock', ready: false },
  { label: 'Clientes', path: '/employee/customers', icon: 'users', ready: true },
  { label: 'Inventario', path: '/employee/inventory', icon: 'box', ready: true }
];

/**
 * Menú lateral. Las opciones cambian según el rol (`Auth`).
 *
 * SEGURIDAD: ocultar/mostrar opciones aquí es solo comodidad visual. El acceso
 * real lo cortan `authGuard` + `roleGuard` (rutas) y la RLS de Supabase (datos).
 */
@Component({
  selector: 'app-sidebar',
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Sidebar {

  private readonly auth = inject(Auth);

  /** Se emite al pulsar una opción; el layout lo usa para cerrar el menú en móvil. */
  readonly navigate = output<void>();

  readonly items = computed<NavItem[]>(() =>
    this.auth.isAdmin() ? ADMIN_NAV : EMPLOYEE_NAV
  );

  protected iconPath(key: string): string {
    return ICONS[key] ?? '';
  }
}
