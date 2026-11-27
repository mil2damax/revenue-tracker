/**
 * log-acknowledgment — records a privacy/confidentiality acceptance.
 *
 * Called BEFORE login (no JWT; verify_jwt = false). The browser sends a
 * per-device token, the clause version accepted, and the user-agent. The REAL
 * public IP is read here from the request headers (never trusted from the
 * client) and the row is written with the service-role key.
 *
 * Body (JSON): { device_id, clause_version, user_agent }
 * Returns: { ok: true } on success.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.39.3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

  let body: { device_id?: string; clause_version?: string; user_agent?: string };
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const device_id      = String(body.device_id || '').slice(0, 200);
  const clause_version = String(body.clause_version || '').slice(0, 50);
  const user_agent     = String(body.user_agent || '').slice(0, 500);
  if (!device_id || !clause_version) return json({ error: 'Missing device_id or clause_version' }, 400);

  // Real public IP from the edge proxy — take the first hop in x-forwarded-for.
  const xff = req.headers.get('x-forwarded-for') || '';
  const ip  = (xff.split(',')[0] || '').trim() || (req.headers.get('x-real-ip') || '').trim() || null;

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { error } = await sb.from('privacy_acknowledgments').insert({
    device_id, clause_version, ip_address: ip, user_agent,
  });
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true });
});
