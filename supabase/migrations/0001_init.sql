-- Hisaab schema.
--
-- Design rule: `raw_name` is written once at capture and never modified.
-- Everything the enrichment pass derives lives in separate nullable columns,
-- so a bad pass can be recomputed without touching what the user actually
-- typed. Proposals land in `enrichment_proposals` and only move onto the
-- transaction once accepted in the review screen.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- entities

create table if not exists items (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users on delete cascade,
  canonical_name text not null,
  category       text,
  aliases        text[] not null default '{}',
  created_at     timestamptz not null default now(),
  unique (user_id, canonical_name)
);

create table if not exists routes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  provider     text not null,
  from_place   text not null,
  to_place     text not null,
  median_minor bigint,
  sample_count int not null default 0,
  created_at   timestamptz not null default now(),
  -- Direction is part of the identity: "Flat -> Office" and "Office -> Flat"
  -- are different routes with different typical fares.
  unique (user_id, provider, from_place, to_place)
);

create table if not exists people (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  display_name text not null,
  aliases      text[] not null default '{}',
  created_at   timestamptz not null default now(),
  unique (user_id, display_name)
);

-- ------------------------------------------------------------ transactions

create table if not exists transactions (
  id                 uuid primary key,
  user_id            uuid not null references auth.users on delete cascade,

  occurred_at        timestamptz not null,
  amount_minor       bigint not null check (amount_minor >= 0),
  currency           text not null default 'PKR',
  direction          text not null check (direction in ('in', 'out')),
  raw_name           text not null,
  source             text not null default 'manual',

  -- Derived by enrichment; all nullable, all safe to recompute.
  item_id            uuid references items on delete set null,
  route_id           uuid references routes on delete set null,
  category           text,
  counterparty_id    uuid references people on delete set null,
  ledger_effect      text check (ledger_effect in ('lent', 'borrowed', 'repaid_by', 'repaid_to')),
  enriched_at        timestamptz,
  enrichment_version int not null default 0,

  client_event_id    text,
  deleted            boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Makes re-importing the same Bluecoins export a no-op. Postgres treats
  -- NULLs as distinct, so manual entries (which have no key) are unaffected.
  unique (user_id, client_event_id)
);

create index if not exists transactions_user_occurred_idx
  on transactions (user_id, occurred_at desc);

-- The sync cursor pages on this.
create index if not exists transactions_user_updated_idx
  on transactions (user_id, updated_at);

-- The enrichment worker's queue.
create index if not exists transactions_pending_enrichment_idx
  on transactions (user_id, occurred_at)
  where enriched_at is null and deleted = false;

-- --------------------------------------------------------------- proposals

create table if not exists enrichment_proposals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users on delete cascade,
  transaction_id uuid not null references transactions on delete cascade,
  proposed       jsonb not null,
  confidence     real,
  model          text,
  status         text not null default 'pending'
                 check (status in ('pending', 'accepted', 'rejected')),
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);

create index if not exists proposals_pending_idx
  on enrichment_proposals (user_id, created_at desc)
  where status = 'pending';

-- Only one open proposal per transaction; a re-run replaces the old one.
create unique index if not exists proposals_one_pending_per_txn
  on enrichment_proposals (transaction_id)
  where status = 'pending';

-- ------------------------------------------------------------------ timing

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists transactions_touch_updated_at on transactions;
create trigger transactions_touch_updated_at
  before update on transactions
  for each row execute function touch_updated_at();

-- --------------------------------------------------------------------- RLS

alter table items                enable row level security;
alter table routes               enable row level security;
alter table people               enable row level security;
alter table transactions         enable row level security;
alter table enrichment_proposals enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['items', 'routes', 'people', 'transactions', 'enrichment_proposals']
  loop
    execute format('drop policy if exists owner_all on %I', t);
    execute format(
      'create policy owner_all on %I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))', t);
  end loop;
end;
$$;
