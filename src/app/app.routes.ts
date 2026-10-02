import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth-guard';
import { roleGuard } from './core/guards/role-guard';
import { guestGuard } from './core/guards/guest-guard';

export const routes: Routes = [
  {
    // La raíz muestra el login directamente (sin redirectTo) para que la barra
    // de direcciones se quede en "/" y no aparezca "/login".
    path: '',
    pathMatch: 'full',
    canMatch: [guestGuard],
    loadComponent: () => import('./pages/auth/login/login').then((m) => m.Login)
  },
  {
    path: 'login',
    canMatch: [guestGuard],
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
    redirectTo: ''
  }
];
