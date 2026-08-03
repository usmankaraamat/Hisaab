-- Accepting a proposal touches four tables: it may mint a canonical item, a
-- route and a person, then stamps the transaction and closes the proposal.
-- Doing that in one SQL function keeps it atomic and keeps the client dumb —
-- the review screen just calls accept_proposal(id).
--
-- These run as SECURITY INVOKER (the default), so RLS still applies and a user
-- can only ever resolve their own proposals.

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
begin
  select * into p from enrichment_proposals where id = p_id and status = 'pending';
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

  v_person_name := nullif(trim(p.proposed ->> 'counterparty'), '');
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
    ledger_effect      = p.proposed ->> 'ledger_effect',
    enriched_at        = now(),
    enrichment_version = enrichment_version + 1
  where id = p.transaction_id;

  update enrichment_proposals
     set status = 'accepted', resolved_at = now()
   where id = p_id;

  return true;
end;
$$;

create or replace function reject_proposal(p_id uuid)
returns boolean
language plpgsql
as $$
begin
  update enrichment_proposals
     set status = 'rejected', resolved_at = now()
   where id = p_id and status = 'pending';

  if not found then
    return false;
  end if;

  -- Stamp the transaction as handled so it does not come back on the next
  -- run. A rejection is a decision, not a retry.
  update transactions t
     set enriched_at = now()
    from enrichment_proposals p
   where p.id = p_id and t.id = p.transaction_id;

  return true;
end;
$$;

-- The one-swipe path on the nightly review screen. Everything at or above
-- `min_confidence` is accepted; the rest stays pending for individual review.
create or replace function accept_pending(min_confidence real default 0.7)
returns integer
language plpgsql
as $$
declare
  r       record;
  n       integer := 0;
begin
  for r in
    select id from enrichment_proposals
     where status = 'pending'
       and coalesce(confidence, 0) >= min_confidence
     order by created_at
  loop
    if accept_proposal(r.id) then
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
