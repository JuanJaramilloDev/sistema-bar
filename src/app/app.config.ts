import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners
} from '@angular/core';
import { Location } from '@angular/common';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';
import { Auth } from './core/services/auth';
import { LastRoute } from './core/services/last-route';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    // La app navega con `skipLocationChange`, así que la barra de direcciones
    // siempre muestra solo el dominio. Si alguien entra o recarga con una ruta
    // escrita (ej. /admin/sales), se limpia a "/" antes de la primera navegación:
    // cae al login, que lo devuelve a su última pantalla si ya tiene sesión.
    provideAppInitializer(() => inject(Location).replaceState('/')),
    // Guarda la pantalla actual para volver a ella al recargar (ver LastRoute).
    provideAppInitializer(() => inject(LastRoute).track()),
    // Comprueba la sesión de Supabase (y carga el perfil) ANTES del primer
    // render, para que los guards ya tengan datos en la primera navegación.
    provideAppInitializer(() => inject(Auth).init())
  ]
};
