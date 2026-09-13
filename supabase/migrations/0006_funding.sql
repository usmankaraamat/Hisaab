-- The account/pot used for a transaction.  Null is intentionally allowed for
-- existing rows and old clients; app code reads it as `essential`.
alter table transactions
  add column if not exists funding_source text
  check (funding_source is null or funding_source in ('essential', 'other'));

create index if not exists transactions_user_funding_source_idx
  on transactions (user_id, funding_source)
  where deleted = false;
