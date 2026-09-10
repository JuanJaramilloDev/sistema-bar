import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';
import { Auth } from './core/services/auth';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    // Comprueba la sesión de Supabase (y carga el perfil) ANTES del primer
    // render, para que los guards ya tengan datos en la primera navegación.
    provideAppInitializer(() => inject(Auth).init())
  ]
};
