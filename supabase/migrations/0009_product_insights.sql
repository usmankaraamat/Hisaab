-- Privacy-conscious product usage and feedback. Raw app content is never collected.

create table if not exists product_installs (
  app text not null check (app in ('eatify', 'hisaab')),
  install_id uuid not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  primary key (app, install_id)
);

create table if not exists product_daily_activity (
  app text not null check (app in ('eatify', 'hisaab')),
  install_id uuid not null,
  activity_day date not null default current_date,
  user_id uuid references auth.users(id) on delete set null,
  activated boolean not null default false,
  signed_in boolean not null default false,
  uses_byok boolean not null default false,
  uses_hosted boolean not null default false,
  last_seen_at timestamptz not null default now(),
  primary key (app, install_id, activity_day)
);

create table if not exists product_feedback (
  id uuid primary key default gen_random_uuid(),
  app text not null check (app in ('eatify', 'hisaab')),
  install_id uuid not null,
  user_id uuid references auth.users(id) on delete set null,
  account_email text,
  reply_email text,
  rating smallint check (rating between 1 and 5),
  message text not null check (char_length(message) between 3 and 4000),
  status text not null default 'new' check (status in ('new', 'reviewed', 'replied', 'archived')),
  created_at timestamptz not null default now()
);

alter table product_installs enable row level security;
alter table product_daily_activity enable row level security;
alter table product_feedback enable row level security;
revoke all on product_installs, product_daily_activity, product_feedback from anon, authenticated;

create or replace function record_product_activity(
  p_app text,
  p_install_id uuid,
  p_user_id uuid,
  p_activated boolean,
  p_uses_byok boolean,
  p_uses_hosted boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_app not in ('eatify', 'hisaab') then
    raise exception 'invalid app';
  end if;

  insert into product_installs(app, install_id, user_id)
  values (p_app, p_install_id, p_user_id)
  on conflict (app, install_id) do update set
    last_seen_at = now(),
    user_id = coalesce(excluded.user_id, product_installs.user_id);

  insert into product_daily_activity(
    app, install_id, activity_day, user_id, activated, signed_in, uses_byok, uses_hosted
  )
  values (
    p_app, p_install_id, current_date, p_user_id, p_activated,
    p_user_id is not null, p_uses_byok, p_uses_hosted
  )
  on conflict (app, install_id, activity_day) do update set
    user_id = coalesce(excluded.user_id, product_daily_activity.user_id),
    activated = product_daily_activity.activated or excluded.activated,
    signed_in = product_daily_activity.signed_in or excluded.signed_in,
    uses_byok = product_daily_activity.uses_byok or excluded.uses_byok,
    uses_hosted = product_daily_activity.uses_hosted or excluded.uses_hosted,
    last_seen_at = now();
end;
$$;
revoke all on function record_product_activity(text, uuid, uuid, boolean, boolean, boolean) from public, anon, authenticated;

create or replace view product_usage_daily as
select
  app,
  activity_day,
  count(*)::bigint as active_installations,
  count(distinct user_id) filter (where user_id is not null)::bigint as signed_in_users,
  count(*) filter (where activated)::bigint as activated_installations,
  count(*) filter (where uses_byok)::bigint as byok_installations,
  count(*) filter (where uses_hosted)::bigint as hosted_installations
from product_daily_activity
group by app, activity_day
order by activity_day desc, app;

create or replace view product_feedback_inbox as
select id, app, rating, message, coalesce(account_email, reply_email) as reply_to,
       account_email is not null as signed_in, status, created_at
from product_feedback
order by created_at desc;

revoke all on product_usage_daily, product_feedback_inbox from anon, authenticated;

create or replace view product_usage_summary as
select
  app,
  count(distinct install_id) filter (where activity_day = current_date)::bigint as daily_active,
  count(distinct install_id) filter (where activity_day >= current_date - 6)::bigint as weekly_active,
  count(distinct install_id) filter (where activity_day >= current_date - 29)::bigint as monthly_active,
  count(distinct user_id) filter (where activity_day >= current_date - 29 and user_id is not null)::bigint as monthly_signed_in,
  count(distinct install_id) filter (where activity_day >= current_date - 29 and activated)::bigint as monthly_activated,
  count(distinct install_id) filter (where activity_day >= current_date - 29 and uses_byok)::bigint as monthly_byok,
  count(distinct install_id) filter (where activity_day >= current_date - 29 and uses_hosted)::bigint as monthly_hosted
from product_daily_activity
group by app
order by app;

revoke all on product_usage_summary from anon, authenticated;
