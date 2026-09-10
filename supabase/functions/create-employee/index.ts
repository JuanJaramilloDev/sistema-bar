// Edge Function: create-employee
// ---------------------------------------------------------------------------
// Crea un usuario de Supabase Auth con rol `employee` y su fila en `profiles`.
//
// Solo Angular (con la sesión del admin) llama a esta función. Aquí, del lado
// del servidor, se verifica que quien llama sea admin y se usa la
// service_role key (inyectada por Supabase, NUNCA está en el frontend).
//
// Deploy:  supabase functions deploy create-employee
// (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY las provee
//  Supabase automáticamente; no hay que configurarlas.)
// ---------------------------------------------------------------------------

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  }

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) {
    return json({ error: 'CONFIG' }, 500);
  }

  // 1. Identificar y autorizar a quien llama
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return json({ error: 'AUTH_REQUIRED' }, 401);
  }

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData.user) {
    return json({ error: 'AUTH_REQUIRED' }, 401);
  }

  const { data: callerProfile } = await caller
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single();

  if (!callerProfile || callerProfile.role !== 'admin') {
    return json({ error: 'NOT_ADMIN' }, 403);
  }

  // 2. Validar la entrada
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');

  if (!name) return json({ error: 'NAME_REQUIRED' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'INVALID_EMAIL' }, 400);
  if (password.length < 6) return json({ error: 'WEAK_PASSWORD' }, 400);

  // 3. Crear el usuario con service_role
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });

  if (createErr || !created.user) {
    const message = createErr?.message ?? '';
    if (/already been registered|already exists|duplicate/i.test(message)) {
      return json({ error: 'EMAIL_TAKEN' }, 409);
    }
    return json({ error: 'CREATE_FAILED', detail: message }, 400);
  }

  // 4. Asegurar el perfil (name + rol employee + activo).
  //    upsert cubre el caso de que un trigger ya haya creado la fila.
  const { error: profileErr } = await admin
    .from('profiles')
    .upsert(
      {
        id: created.user.id,
        name,
        email,
        role: 'employee',
        active: true,
      },
      { onConflict: 'id' },
    );

  if (profileErr) {
    // Evitar dejar un usuario de Auth sin perfil.
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: 'PROFILE_FAILED', detail: profileErr.message }, 400);
  }

  return json(
    {
      id: created.user.id,
      name,
      email,
      role: 'employee',
      active: true,
      created_at: created.user.created_at,
    },
    201,
  );
});
