-- Hosted AI allowance. Limits live in the database so clients cannot raise them.
-- Counters reset at midnight in Pakistan, matching Hisaab's calendar.

create table if not exists hosted_feature_limits (
  feature            text primary key,
  user_daily_limit   integer not null check (user_daily_limit > 0),
  global_daily_limit integer not null check (global_daily_limit > 0),
  enabled            boolean not null default true,
  updated_at         timestamptz not null default now()
);

insert into hosted_feature_limits (feature, user_daily_limit, global_daily_limit)
values ('hisaab_enrichment', 5, 500)
on conflict (feature) do update set
  user_daily_limit = excluded.user_daily_limit,
  global_daily_limit = excluded.global_daily_limit,
  updated_at = now();

create table if not exists hosted_user_usage (
  feature    text not null references hosted_feature_limits(feature) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  usage_day  date not null,
  used       integer not null default 0 check (used >= 0),
  updated_at timestamptz not null default now(),
  primary key (feature, user_id, usage_day)
);

create table if not exists hosted_global_usage (
  feature    text not null references hosted_feature_limits(feature) on delete cascade,
  usage_day  date not null,
  used       integer not null default 0 check (used >= 0),
  updated_at timestamptz not null default now(),
  primary key (feature, usage_day)
);

alter table hosted_feature_limits enable row level security;
alter table hosted_user_usage enable row level security;
alter table hosted_global_usage enable row level security;

-- Edge Functions call these with the service role after independently verifying
-- the caller's JWT. No browser role can inspect or mutate another user's counts.
create or replace function reserve_hosted_quota(p_user_id uuid, p_feature text)
returns table (
  allowed boolean,
  reason text,
  used integer,
  daily_limit integer,
  reset_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := timezone('Asia/Karachi', now())::date;
  v_user_limit integer;
  v_global_limit integer;
  v_user_used integer;
  v_global_used integer;
  v_reset timestamptz :=
    (date_trunc('day', timezone('Asia/Karachi', now())) + interval '1 day')
      at time zone 'Asia/Karachi';
begin
  select user_daily_limit, global_daily_limit
    into v_user_limit, v_global_limit
    from hosted_feature_limits
   where feature = p_feature and enabled = true;

  if not found then
    return query select false, 'unavailable', 0, 0, v_reset;
    return;
  end if;

  insert into hosted_global_usage(feature, usage_day, used)
  values (p_feature, v_day, 1)
  on conflict (feature, usage_day) do update
    set used = hosted_global_usage.used + 1, updated_at = now()
    where hosted_global_usage.used < v_global_limit
  returning hosted_global_usage.used into v_global_used;

  if v_global_used is null then
    return query select false, 'global_limit', 0, v_user_limit, v_reset;
    return;
  end if;

  insert into hosted_user_usage(feature, user_id, usage_day, used)
  values (p_feature, p_user_id, v_day, 1)
  on conflict (feature, user_id, usage_day) do update
    set used = hosted_user_usage.used + 1, updated_at = now()
    where hosted_user_usage.used < v_user_limit
  returning hosted_user_usage.used into v_user_used;

  if v_user_used is null then
    update hosted_global_usage
       set used = greatest(used - 1, 0), updated_at = now()
     where feature = p_feature and usage_day = v_day;
    select u.used into v_user_used
      from hosted_user_usage u
     where u.feature = p_feature and u.user_id = p_user_id and u.usage_day = v_day;
    return query select false, 'user_limit', coalesce(v_user_used, v_user_limit), v_user_limit, v_reset;
    return;
  end if;

  return query select true, 'ok', v_user_used, v_user_limit, v_reset;
end;
$$;

create or replace function release_hosted_quota(p_user_id uuid, p_feature text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := timezone('Asia/Karachi', now())::date;
begin
  update hosted_user_usage
     set used = greatest(used - 1, 0), updated_at = now()
   where feature = p_feature and user_id = p_user_id and usage_day = v_day;
  update hosted_global_usage
     set used = greatest(used - 1, 0), updated_at = now()
   where feature = p_feature and usage_day = v_day;
end;
$$;

revoke all on hosted_feature_limits, hosted_user_usage, hosted_global_usage from anon, authenticated;
revoke all on function reserve_hosted_quota(uuid, text) from public, anon, authenticated;
revoke all on function release_hosted_quota(uuid, text) from public, anon, authenticated;
grant execute on function reserve_hosted_quota(uuid, text) to service_role;
grant execute on function release_hosted_quota(uuid, text) to service_role;
