export const environment = {
  production: false,
  // URL BASE del proyecto Supabase (sin /rest/v1 ni ninguna ruta).
  // supabase-js le agrega internamente /auth/v1, /rest/v1, /storage/v1, etc.
  supabaseUrl: 'https://jssnewcnoophcnssmcpl.supabase.co',
  // Clave PUBLICABLE / anon (segura para el navegador).
  // NUNCA poner aquí la service_role key ni ningún secreto.
  supabaseKey: 'sb_publishable_KgR2kV3oOWUa1alSIluSnA_ZTJysqZi'
};
