import { createClient } from 'jsr:@supabase/supabase-js@2';

export type Quota = {
  allowed: boolean;
  reason: string;
  used: number;
  daily_limit: number;
  reset_at: string;
};

const url = Deno.env.get('SUPABASE_URL')!;
const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

export async function authenticate(request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization) return null;
  const db = createClient(url, anon, { global: { headers: { Authorization: authorization } } });
  const { data, error } = await db.auth.getUser();
  return error ? null : data.user;
}

function admin() {
  return createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function reserveQuota(userId: string, feature: string): Promise<Quota> {
  const { data, error } = await admin().rpc('reserve_hosted_quota', {
    p_user_id: userId,
    p_feature: feature,
  });
  if (error) throw error;
  return data?.[0] ?? { allowed: false, reason: 'unavailable', used: 0, daily_limit: 0, reset_at: '' };
}

export async function releaseQuota(userId: string, feature: string) {
  await admin().rpc('release_hosted_quota', { p_user_id: userId, p_feature: feature });
}

export function quotaMessage(quota: Quota) {
  if (quota.reason === 'user_limit') return `Today's ${quota.daily_limit} hosted categorisation batches are used.`;
  if (quota.reason === 'global_limit') return 'Hosted categorisation is busy for today. Your local ledger still works.';
  return 'Hosted categorisation is temporarily unavailable.';
}
