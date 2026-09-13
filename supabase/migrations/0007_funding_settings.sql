-- One immutable opening snapshot per authenticated user. Transaction sources
-- sync independently; this table establishes the two balances they start at.
create table if not exists funding_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  essential_minor bigint not null check (essential_minor >= 0),
  other_minor bigint not null check (other_minor >= 0),
  snapshot_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table funding_settings enable row level security;

drop policy if exists "own funding settings" on funding_settings;
drop policy if exists "read own funding settings" on funding_settings;
drop policy if exists "insert own funding settings" on funding_settings;
create policy "read own funding settings"
  on funding_settings for select to authenticated
  using (user_id = (select auth.uid()));
create policy "insert own funding settings"
  on funding_settings for insert to authenticated
  with check (user_id = (select auth.uid()));

-- There is deliberately no UPDATE or DELETE permission or policy: changing a
-- snapshot after transactions have been assigned to pots would rewrite history.
revoke all on table funding_settings from anon, authenticated;
grant select, insert on table funding_settings to authenticated;

-- INSERT ... ON CONFLICT DO NOTHING establishes the first count. The SELECT
-- runs as a second statement in this function, so it sees a concurrent winner
-- after PostgreSQL has waited for that winner's transaction to settle.
create or replace function establish_funding_settings(
  p_essential_minor bigint default null,
  p_other_minor bigint default null,
  p_snapshot_at timestamptz default null
)
returns table (
  essential_minor bigint,
  other_minor bigint,
  snapshot_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if (p_essential_minor is null) <> (p_other_minor is null)
     or (p_essential_minor is null) <> (p_snapshot_at is null) then
    raise exception 'Funding snapshot must be complete';
  end if;
  if p_essential_minor is not null then
    insert into funding_settings (user_id, essential_minor, other_minor, snapshot_at)
    values (auth.uid(), p_essential_minor, p_other_minor, p_snapshot_at)
    on conflict (user_id) do nothing;
  end if;

  return query
    select f.essential_minor, f.other_minor, f.snapshot_at
    from funding_settings f
    where f.user_id = auth.uid();
end;
$$;

revoke all on function establish_funding_settings(bigint, bigint, timestamptz) from public, anon;
grant execute on function establish_funding_settings(bigint, bigint, timestamptz) to authenticated;
