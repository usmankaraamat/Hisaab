-- Run through the Supabase management SQL API after migrations 0006 and 0007.
-- The entire fixture is rolled back: it creates no user or spending data.
begin;

do $$
declare
  a uuid := '11111111-1111-4111-8111-111111111111';
  b uuid := '22222222-2222-4222-8222-222222222222';
begin
  -- These are the minimal stable fields for GoTrue auth.users. The UUIDs are
  -- synthetic and disappear on rollback along with the funding rows.
  insert into auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values
    (a, 'authenticated', 'authenticated', 'funding-test-a@example.invalid', '', now(), '{}', '{}', now(), now()),
    (b, 'authenticated', 'authenticated', 'funding-test-b@example.invalid', '', now(), '{}', '{}', now(), now());
end $$;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

-- First insert returns the submitted complete snapshot.
do $$
declare r record;
begin
  select * into r from establish_funding_settings(100000, 500000, '2026-09-01T10:00:00Z');
  if r.essential_minor <> 100000 or r.other_minor <> 500000 or r.snapshot_at <> '2026-09-01T10:00:00Z'::timestamptz then
    raise exception 'first funding snapshot was not returned intact';
  end if;
  select * into r from establish_funding_settings(999999, 1, '2026-10-01T10:00:00Z');
  if r.essential_minor <> 100000 or r.other_minor <> 500000 or r.snapshot_at <> '2026-09-01T10:00:00Z'::timestamptz then
    raise exception 'second funding snapshot overwrote the first';
  end if;
end $$;

-- A second auth identity sees no first account row and establishes its own.
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
do $$
declare r record;
begin
  select * into r from establish_funding_settings();
  if found then raise exception 'funding settings leaked across users'; end if;
  select * into r from establish_funding_settings(200000, 300000, '2026-09-02T10:00:00Z');
  if r.essential_minor <> 200000 or r.other_minor <> 300000 then
    raise exception 'second user could not establish isolated snapshot';
  end if;
end $$;

-- Permissions and schema are part of the protocol, not documentation only.
do $$
begin
  if has_table_privilege('authenticated', 'public.funding_settings', 'UPDATE')
     or has_table_privilege('authenticated', 'public.funding_settings', 'DELETE') then
    raise exception 'funding settings must be immutable to authenticated users';
  end if;
  if has_function_privilege('anon', 'public.establish_funding_settings(bigint,bigint,timestamptz)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.establish_funding_settings(bigint,bigint,timestamptz)', 'EXECUTE') then
    raise exception 'funding RPC grants are incorrect';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'transactions' and column_name = 'funding_source'
  ) then
    raise exception 'transactions.funding_source migration is absent';
  end if;
end $$;

rollback;
