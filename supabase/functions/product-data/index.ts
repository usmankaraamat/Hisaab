import { createClient } from 'jsr:@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL')!;
const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

function cors(request: Request) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': request.headers.get('access-control-request-headers') ?? 'authorization, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '86400',
  };
}
function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors(request) },
  });
}
async function account(request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization) return null;
  const db = createClient(url, anon, { global: { headers: { Authorization: authorization } } });
  const { data, error } = await db.auth.getUser();
  return error ? null : data.user;
}
function validUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function validEmail(value: unknown) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed.' }, 405);

  const body = await request.json().catch(() => ({}));
  const app = body.app === 'eatify' || body.app === 'hisaab' ? body.app : null;
  const installId = validUuid(body.installId) ? body.installId : null;
  const kind = body.kind === 'activity' || body.kind === 'feedback' ? body.kind : null;
  if (!app || !installId || !kind) return json(request, { error: 'Invalid request.' }, 400);

  const user = await account(request);
  if (kind === 'activity') {
    const { error } = await admin.rpc('record_product_activity', {
      p_app: app,
      p_install_id: installId,
      p_user_id: user?.id ?? null,
      p_activated: body.activated === true,
      p_uses_byok: body.usesByok === true,
      p_uses_hosted: body.usesHosted === true,
    });
    return error ? json(request, { error: 'Could not record activity.' }, 500) : json(request, { ok: true });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const rating = Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5 ? body.rating : null;
  const replyEmail = validEmail(body.replyEmail);
  if (message.length < 3 || message.length > 4000) {
    return json(request, { error: 'Write between 3 and 4,000 characters.' }, 400);
  }
  if (body.replyEmail && !replyEmail) return json(request, { error: 'That reply email does not look valid.' }, 400);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await admin.from('product_feedback').select('id', { count: 'exact', head: true })
    .eq('app', app).eq('install_id', installId).gte('created_at', since);
  if ((count ?? 0) >= 5) return json(request, { error: 'You have sent enough for today. Try again tomorrow.' }, 429);

  const { error } = await admin.from('product_feedback').insert({
    app,
    install_id: installId,
    user_id: user?.id ?? null,
    account_email: user?.email ?? null,
    reply_email: user ? null : replyEmail,
    rating,
    message,
  });
  return error
    ? json(request, { error: 'Could not send that right now.' }, 500)
    : json(request, { ok: true, replyTo: user?.email ?? replyEmail ?? null });
});

