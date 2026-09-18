-- Kept in sync with Eatify's shared Supabase project migration.
create table if not exists product_daily_events (
  app text not null check (app in ('eatify', 'hisaab', 'portfolio')),
  install_id uuid not null,
  event_day date not null default current_date,
  event text not null check (event in ('page_view','install_invite_shown','install_invite_dismissed','install_accepted','install_prompt_dismissed','install_ios_help','install_help','installed')),
  page text not null default '',
  event_count integer not null default 1 check (event_count between 1 and 10000),
  first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  primary key (app, install_id, event_day, event, page)
);
alter table product_daily_events enable row level security;
revoke all on product_daily_events from anon, authenticated;
create or replace function record_product_event(p_app text,p_install_id uuid,p_event text,p_page text)
returns void language plpgsql security definer set search_path=public as $$
begin
  if p_app not in ('eatify','hisaab','portfolio') then raise exception 'invalid app'; end if;
  if p_event not in ('page_view','install_invite_shown','install_invite_dismissed','install_accepted','install_prompt_dismissed','install_ios_help','install_help','installed') then raise exception 'invalid event'; end if;
  insert into product_daily_events(app,install_id,event,page) values(p_app,p_install_id,p_event,left(coalesce(p_page,''),120))
  on conflict(app,install_id,event_day,event,page) do update set event_count=least(product_daily_events.event_count+1,10000),last_seen_at=now();
end; $$;
revoke all on function record_product_event(text,uuid,text,text) from public,anon,authenticated;
create or replace view product_event_daily as select app,event_day,event,page,count(*)::bigint unique_visitors,sum(event_count)::bigint total_events from product_daily_events group by app,event_day,event,page order by event_day desc,app,event,page;
create or replace view portfolio_usage_summary as select count(distinct install_id) filter(where event_day=current_date and event='page_view')::bigint daily_visitors,count(distinct install_id) filter(where event_day>=current_date-6 and event='page_view')::bigint weekly_visitors,count(distinct install_id) filter(where event_day>=current_date-29 and event='page_view')::bigint monthly_visitors,coalesce(sum(event_count) filter(where event_day>=current_date-29 and event='page_view'),0)::bigint monthly_page_views from product_daily_events where app='portfolio';
revoke all on product_event_daily,portfolio_usage_summary from anon,authenticated;
