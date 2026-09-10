import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth-guard';
import { roleGuard } from './core/guards/role-guard';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'login'
  },
  {
    path: 'login',
    loadComponent: () => import('./pages/auth/login/login').then((m) => m.Login)
  },
  {
    path: 'admin',
    canMatch: [authGuard, roleGuard],
    data: { role: 'admin' },
    loadChildren: () =>
      import('./pages/admin/admin.routes').then((m) => m.ADMIN_ROUTES)
  },
  {
    path: 'employee',
    canMatch: [authGuard, roleGuard],
    data: { role: 'employee' },
    loadChildren: () =>
      import('./pages/employee/employee.routes').then((m) => m.EMPLOYEE_ROUTES)
  },
  {
    path: '**',
    redirectTo: 'login'
  }
];
