-- Display names, a cleaner taxonomy, and the entity cleanup that makes
-- category reporting trustworthy.
--
-- Three problems in the live data motivated this:
--
--   1. The enrichment pass already resolves "home office indrive" to the route
--      Home -> Office, but every screen renders `raw_name`, so the user never
--      sees it. `raw_name` is immutable by design — a bad pass has to be
--      recomputable against what was actually typed — so the tidy version needs
--      a column of its own rather than an edit in place.
--
--   2. Thirteen of thirty canonical items were route strings ("Gym - Home",
--      "NUST -> 26 Number"), in two different formats. Rides already have a
--      `routes` table with a proper (from, to, provider) key; the parallel item
--      rows were duplicates that split every future per-category total.
--
--   3. "Movie Tickets" was filed under Subscriptions and "Investment" under
--      Transfers & Loans, because the category list had nowhere better. A
--      savings transfer counted as spending makes a "money left" figure wrong
--      on day one, which is the fastest way to make it untrusted.

alter table transactions
  -- The tidy one-line version of what was typed: "Indrive Gym → Office" for a
  -- ride, "Cake for Jahangir" for a shared treat. Nullable and model-derived
  -- like every other enrichment field, so it can be recomputed.
  add column if not exists display_name text;

-- --------------------------------------------------------- accept_proposal
--
-- Reissued from 0003 with two changes:
--   * `display_name` is stored (capture-time text still wins for `raw_name`).
--   * a ride no longer mints an `items` row — its route is its identity, and
--     writing both produced the duplicate entities cleaned up below.

create or replace function accept_proposal(p_id uuid)
returns boolean
language plpgsql
as $$
declare
  p             enrichment_proposals;
  v_route       jsonb;
  v_item_id     uuid;
  v_route_id    uuid;
  v_person      uuid;
  v_item        text;
  v_person_name text;
  v_display     text;
  v_existing    transactions;
begin
  select * into p from enrichment_proposals where id = p_id and status = 'pending';
  if not found then
    return false;
  end if;

  select * into v_existing from transactions where id = p.transaction_id;
  if not found then
    return false;
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

  -- Only non-rides get an item. A route already names the thing that was bought.
  v_item := nullif(trim(p.proposed ->> 'canonical_item'), '');
  if v_item is not null and v_route_id is null then
    insert into items (user_id, canonical_name, category)
    values (p.user_id, v_item, p.proposed ->> 'category')
    on conflict (user_id, canonical_name)
      do update set category = coalesce(items.category, excluded.category)
    returning id into v_item_id;
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

  v_display := nullif(trim(p.proposed ->> 'display_name'), '');

  update transactions set
    category           = coalesce(p.proposed ->> 'category', category),
    display_name       = coalesce(v_display, display_name),
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

-- ------------------------------------------------------------- taxonomy

-- Money moved into savings or an investment is not consumption. Separating it
-- from loans and remittances is what lets "left to spend" be honest.
update transactions set category = 'Savings'
 where category = 'Transfers & Loans'
   and direction = 'out'
   and raw_name ~* '\y(investment|savings|invest|mutual fund|stocks?)\y';

update items set category = 'Savings'
 where category = 'Transfers & Loans'
   and canonical_name ~* '\y(investment|savings|invest)\y';

-- Cinema is not a subscription. The old list had no Entertainment, so the
-- model put it in the closest thing available.
update transactions t set category = 'Entertainment'
  from items i
 where i.id = t.item_id
   and i.canonical_name ~* '\y(movie|cinema|concert|tickets?)\y'
   and t.category = 'Subscriptions';

update items set category = 'Entertainment'
 where canonical_name ~* '\y(movie|cinema|concert)\y'
   and category = 'Subscriptions';

-- ------------------------------------------------- backfill display_name
--
-- Rides only, and deliberately so. A route reconstructs to exactly the right
-- name — provider, both places, the direction — with no information lost.
--
-- The `items` table cannot do the same job, even though it is tempting. Rule 1a
-- of the prompt tells the model to prefer a *general* canonical item, so that
-- future variants land on it: "Eggs + Bread" canonicalises to "Groceries" and
-- "Raj Kachori" to "Eating Out". Those are correct as items and useless as
-- display names — the backfill would replace what the user typed with something
-- less informative than the original.
--
-- So everything else is left null and falls back to `raw_name` until the next
-- enrichment pass supplies a real display name from the text itself.

update transactions t
   set display_name = initcap(r.provider) || ' ' || r.from_place || ' → ' || r.to_place
  from routes r
 where r.id = t.route_id
   and t.display_name is null;

-- ------------------------------------------------------ entity cleanup
--
-- Drop the route-shaped item rows now that display names no longer depend on
-- them. `item_id` is cleared first so the delete cannot orphan a reference.

update transactions set item_id = null
 where item_id in (select id from items where category = 'Rides');

delete from items where category = 'Rides';
