/* Auto-capture ingest.
 *
 * A phone automation (MacroDroid / Tasker / HTTP Shortcuts) watching payment
 * notifications POSTs each one here, carrying a per-user token instead of a
 * login — an automation app cannot hold a Supabase session. This function
 * resolves the token to a user with the service-role key and drops the raw text
 * into `payment_inbox`. It never parses or interprets anything; the signed-in
 * app pulls the row and turns it into a pending capture on the device.
 *
 * Three request shapes, because the automation app is building the request out
 * of string substitution and a bank SMS is not a safe thing to paste into JSON.
 * A single quote or a line break in the notification would make the body
 * unparseable, and the capture would be lost silently — so the shape that needs
 * no escaping at all is the one the docs recommend:
 *
 *   1. token in the `X-Ingest-Token` header (or `?token=`), notification as the
 *      raw request body. Nothing to escape: the body is opaque text.
 *   2. application/json          { token, body, app }
 *   3. form-urlencoded           token=…&body=…&app=…
 *
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
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-ingest-token, x-ingest-app',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

/** Pull { token, body, app } out of whichever shape the automation sent. */
async function readRequest(req: Request) {
  const url = new URL(req.url);
  const type = req.headers.get('content-type') ?? '';
  const raw = await req.text();

  let fields: { token?: string; body?: string; app?: string } = {};
  if (type.includes('application/json')) {
    try {
      fields = JSON.parse(raw);
    } catch {
      // A malformed JSON body is still a notification if a token came in the
      // header or the query — treat the text as the message rather than 400.
      fields = { body: raw };
    }
  } else if (type.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(raw);
    fields = {
      token: form.get('token') ?? undefined,
      body: form.get('body') ?? undefined,
      app: form.get('app') ?? undefined,
    };
  } else {
    fields = { body: raw };
  }

  // Header and query beat the body: they are the escape-free path, and they are
  // what the setup doc tells you to use.
  return {
    token: (req.headers.get('x-ingest-token') ?? url.searchParams.get('token') ?? fields.token ?? '').trim(),
    body: String(fields.body ?? '').trim(),
    app: (req.headers.get('x-ingest-app') ?? url.searchParams.get('app') ?? fields.app ?? '').trim(),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const { token, body, app } = await readRequest(req);
  if (!token) return json(400, { error: 'a token is required' });
  if (!body) return json(400, { error: 'a message body is required' });
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
    app: app ? app.slice(0, 60) : null,
  });
  if (error) return json(500, { error: 'could not store' });

  return json(200, { ok: true });
});
