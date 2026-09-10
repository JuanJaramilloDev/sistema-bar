import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * La app es una herramienta interna autenticada: no hay SEO ni contenido
 * público que prerenderizar, y la sesión de Supabase vive en el navegador.
 * Por eso TODAS las rutas se renderizan en cliente (el servidor solo entrega
 * el shell). Los guards nunca se ejecutan en el servidor.
 *
 * Recomendado para más adelante: eliminar SSR por completo (ver notas de fase).
 */
export const serverRoutes: ServerRoute[] = [
  {
    path: '**',
    renderMode: RenderMode.Client
  }
];
