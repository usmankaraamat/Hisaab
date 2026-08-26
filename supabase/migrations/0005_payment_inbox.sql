-- Auto-capture: a quarantine inbox for payment notifications forwarded from the
-- phone by an automation app (MacroDroid / Tasker / HTTP Shortcuts).
--
-- The flow: a NotificationListener automation POSTs the notification text to the
-- `ingest` Edge Function with a per-user token. The function (service role)
-- resolves the token to a user and drops the raw text into `payment_inbox`. The
-- signed-in app pulls its own rows via RLS, parses each into a pending capture
-- locally, and deletes them. Nothing here is ever spending until the user
-- resolves it on the device — the server only relays text.

-- A random token the automation carries in place of a login. One or more per
-- user; revocable by deleting the row.
create table if not exists ingest_tokens (
  token      text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  label      text,
  created_at timestamptz not null default now()
);

alter table ingest_tokens enable row level security;

-- A user manages only their own tokens. The Edge Function reads them with the
-- service-role key, which bypasses RLS, so there is no public read path.
create policy "own ingest tokens"
  on ingest_tokens for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- The forwarded messages, waiting to be pulled. Insert is service-role only
-- (the Edge Function); the owner can read and delete their own.
create table if not exists payment_inbox (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  app        text,
  body       text not null,
  created_at timestamptz not null default now()
);

alter table payment_inbox enable row level security;

create policy "own inbox read"
  on payment_inbox for select
  using (user_id = auth.uid());

create policy "own inbox delete"
  on payment_inbox for delete
  using (user_id = auth.uid());

create index if not exists payment_inbox_user_created
  on payment_inbox (user_id, created_at);
