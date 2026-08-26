/* Auto-capture ingest.
 *
 * A phone automation (MacroDroid / Tasker / HTTP Shortcuts) watching payment
 * notifications POSTs each one here, carrying a per-user token instead of a
 * login — an automation app cannot hold a Supabase session. This function
 * resolves the token to a user with the service-role key and drops the raw text
 * into `payment_inbox`. It never parses or interprets anything; the signed-in
 * app pulls the row and turns it into a pending capture on the device.
 *
 * Request:  POST { "token": "...", "body": "Rs. 675 sent to …", "app": "easypaisa" }
 * Response: 200 { ok: true } | 401 bad token | 400 bad request
 *
 * Deploy:   supabase functions deploy ingest --no-verify-jwt
 * (--no-verify-jwt because the caller is an automation with a token, not a JWT.)
 * The function needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, which Supabase
 * injects into deployed functions automatically.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  let payload: { token?: string; body?: string; app?: string };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: 'invalid JSON' });
  }

  const token = String(payload.token ?? '').trim();
  const body = String(payload.body ?? '').trim();
  if (!token || !body) return json(400, { error: 'token and body are required' });
  if (body.length > 2000) return json(400, { error: 'body too long' });

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );

  const { data: match } = await admin
    .from('ingest_tokens')
    .select('user_id')
    .eq('token', token)
    .maybeSingle();

  if (!match) return json(401, { error: 'unknown token' });

  const { error } = await admin.from('payment_inbox').insert({
    user_id: match.user_id,
    body,
    app: payload.app ? String(payload.app).slice(0, 60) : null,
  });
  if (error) return json(500, { error: 'could not store' });

  return json(200, { ok: true });
});
