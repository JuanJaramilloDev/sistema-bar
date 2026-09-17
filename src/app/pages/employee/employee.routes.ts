import { Routes } from '@angular/router';
import { Layout } from '../../shared/components/layout/layout';

/**
 * Rama /employee. Protegida en app.routes.ts con authGuard + roleGuard('employee').
 * Todas las páginas cuelgan del layout común (sidebar + navbar).
 *
 * `inventory` y `customers` reutilizan el componente de admin (el componente se
 * adapta al rol; la RLS/RPC de Supabase impone la seguridad real).
 */
export const EMPLOYEE_ROUTES: Routes = [
  {
    path: '',
    component: Layout,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./dashboard/dashboard').then((m) => m.Dashboard)
      },
      {
        path: 'sales',
        loadComponent: () => import('./sales/sales').then((m) => m.Sales)
      },
      {
        path: 'pending',
        loadComponent: () => import('./pending/pending').then((m) => m.Pending)
      },
      {
        path: 'inventory',
        loadComponent: () =>
          import('./inventory/inventory').then((m) => m.Inventory)
      },
      {
        path: 'customers',
        loadComponent: () =>
          import('./customers/customers').then((m) => m.Customers)
      }
    ]
  }
];
