-- Shared expenses and the debt ledger.
--
-- Buying something for other people is a debt, and the user says so explicitly
-- at capture ("cake for tom, dick, harry 2500"). That line becomes one row per
-- person, each carrying a counterparty and a ledger effect, written on the
-- device with no model involved.
--
-- Which creates a rule this migration has to enforce: enrichment may fill these
-- fields in, but it may never overwrite them. Capture-time facts were stated by
-- the user; enrichment output is inferred. See accept_proposal below.

alter table transactions
  -- The counterparty as a name, not just an id. Two reasons: the device knows
  -- the name at capture but cannot mint a `people` row offline, and the ledger
  -- has to render on a client that never sees the `people` table.
  add column if not exists counterparty_name text,
  -- Not every "for someone" entry is a real debt — a treat for a sibling is
  -- often a gift. Rather than guess, the balance is tracked and can be called
  -- square in one tap, which leaves the spend intact in history.
  add column if not exists ledger_settled boolean not null default false,
  -- The rows derived from one typed line, and what that line was.
  add column if not exists split_group_id uuid,
  add column if not exists split_size int,
  add column if not exists source_text text;

create index if not exists transactions_ledger_idx
  on transactions (user_id, counterparty_name)
  where counterparty_name is not null and ledger_effect is not null and deleted = false;

create index if not exists transactions_split_group_idx
  on transactions (user_id, split_group_id)
  where split_group_id is not null;

-- Backfill the name for anything an earlier enrichment pass already resolved,
-- so the ledger sees a complete picture rather than only post-upgrade rows.
update transactions t
   set counterparty_name = p.display_name
  from people p
 where t.counterparty_id = p.id
   and t.counterparty_name is null;

-- --------------------------------------------------------- accept_proposal
--
-- Reissued with one change from 0002: counterparty and ledger_effect are now
-- coalesced against what is already on the row instead of overwriting it. A
-- split entry keeps the person and the effect the user named; the model still
-- supplies the category, item and route, which capture never knew.

create or replace function accept_proposal(p_id uuid)
returns boolean
language plpgsql
as $$
declare
  p          enrichment_proposals;
  v_route    jsonb;
  v_item_id  uuid;
  v_route_id uuid;
  v_person   uuid;
  v_item     text;
  v_person_name text;
  v_existing transactions;
begin
  select * into p from enrichment_proposals where id = p_id and status = 'pending';
  if not found then
    return false;
  end if;

  select * into v_existing from transactions where id = p.transaction_id;
  if not found then
    return false;
  end if;

  v_item := nullif(trim(p.proposed ->> 'canonical_item'), '');
  if v_item is not null then
    insert into items (user_id, canonical_name, category)
    values (p.user_id, v_item, p.proposed ->> 'category')
    on conflict (user_id, canonical_name)
      do update set category = coalesce(items.category, excluded.category)
    returning id into v_item_id;
  end if;

  v_route := p.proposed -> 'route';
  if v_route is not null and jsonb_typeof(v_route) = 'object' then
    insert into routes (user_id, provider, from_place, to_place, sample_count)
    values (
      p.user_id,
      lower(v_route ->> 'provider'),
      v_route ->> 'from',
      v_route ->> 'to',
      1
    )
    on conflict (user_id, provider, from_place, to_place)
      do update set sample_count = routes.sample_count + 1
    returning id into v_route_id;
  end if;

  -- Capture wins. Only fall back to the model's guess when the row is silent.
  v_person_name := coalesce(
    nullif(trim(v_existing.counterparty_name), ''),
    nullif(trim(p.proposed ->> 'counterparty'), '')
  );
  if v_person_name is not null then
    insert into people (user_id, display_name)
    values (p.user_id, v_person_name)
    on conflict (user_id, display_name)
      do update set display_name = excluded.display_name
    returning id into v_person;
  end if;

  update transactions set
    category           = coalesce(p.proposed ->> 'category', category),
    item_id            = coalesce(v_item_id, item_id),
    route_id           = coalesce(v_route_id, route_id),
    counterparty_id    = coalesce(v_person, counterparty_id),
    counterparty_name  = v_person_name,
    ledger_effect      = coalesce(ledger_effect, p.proposed ->> 'ledger_effect'),
    enriched_at        = now(),
    enrichment_version = enrichment_version + 1
  where id = p.transaction_id;

  update enrichment_proposals
     set status = 'accepted', resolved_at = now()
   where id = p_id;

  return true;
end;
$$;
