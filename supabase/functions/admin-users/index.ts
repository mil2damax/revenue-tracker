/**
 * admin-users — owner-only user administration.
 *
 * Every request must carry a logged-in user's JWT (Authorization: Bearer ...).
 * The function verifies that user is an OWNER before the service-role key is
 * used for anything. Non-owners get 403; anonymous/anon-key callers get 401.
 *
 * Actions (JSON body { action, ... }):
 *   list          -> [{ id, email, role, properties[] }]
 *   set_password  -> { user_id, password }  (>= 8 chars)
 */
import { createClient } from 'npm:@supabase/supabase-js@2.39.3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')   return json({ error: 'Method not allowed' }, 405);

  // 1. Identify the caller from their JWT
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Not authenticated' }, 401);

  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !user) return json({ error: 'Not authenticated' }, 401);

  // 2. Service-role client + owner check (never act before this passes)
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: prof } = await admin
    .from('profiles').select('role').eq('user_id', user.id).single();
  if (!prof || prof.role !== 'owner') return json({ error: 'Owner access required' }, 403);

  // 3. Dispatch
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }

  if (body.action === 'list') {
    const { data: list, error } = await admin.auth.admin.listUsers();
    if (error) return json({ error: error.message }, 500);
    const { data: profiles } = await admin.from('profiles').select('user_id, role');
    const { data: props }    = await admin.from('user_properties').select('user_id, property');
    const roleBy = new Map((profiles || []).map((p: any) => [p.user_id, p.role]));
    const propsBy = new Map<string, string[]>();
    for (const r of props || []) {
      const arr = propsBy.get(r.user_id) || [];
      arr.push(r.property); propsBy.set(r.user_id, arr);
    }
    const users = list.users.map((u: any) => ({
      id: u.id,
      email: u.email,
      role: roleBy.get(u.id) || 'manager',
      properties: propsBy.get(u.id) || [],
      last_sign_in_at: u.last_sign_in_at,
    }));
    return json({ users });
  }

  if (body.action === 'set_password') {
    const { user_id, password } = body;
    if (!user_id || typeof password !== 'string' || password.length < 8)
      return json({ error: 'A user and a password of at least 8 characters are required' }, 400);
    const { error } = await admin.auth.admin.updateUserById(user_id, { password });
    if (error) return json({ error: error.message }, 500);
    return json({ success: true });
  }

  return json({ error: 'Unknown action' }, 400);
});
