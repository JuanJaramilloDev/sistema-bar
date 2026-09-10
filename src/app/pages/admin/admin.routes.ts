import { Routes } from '@angular/router';
import { Layout } from '../../shared/components/layout/layout';

/**
 * Rama /admin. Protegida en app.routes.ts con authGuard + roleGuard('admin').
 * Todas las páginas cuelgan del layout común (sidebar + navbar).
 *
 * Los módulos ventas / invoices / reports / employees se añaden aquí en sus
 * fases; hasta entonces el sidebar los muestra como "Pronto".
 *
 * El módulo de empleados (`pages/admin/employees/`, `core/services/employees.ts`
 * y la Edge Function `create-employee`) está construido pero desconectado hasta
 * retomarlo.
 */
export const ADMIN_ROUTES: Routes = [
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
        path: 'categories',
        loadComponent: () =>
          import('./categories/categories').then((m) => m.Categories)
      },
      {
        path: 'products',
        loadComponent: () =>
          import('./products/products').then((m) => m.Products)
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
