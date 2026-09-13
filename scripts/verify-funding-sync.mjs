/* Protocol tests with an in-memory Supabase RPC, including concurrent callers. */
import { syncFundingSnapshot } from '../src/db/funding-sync.js';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`);
}

function mockFundingServer({ fail = false } = {}) {
  const rows = new Map();
  let shouldFail = fail;
  return {
    rows,
    failNext() { shouldFail = true; },
    client: {
      async rpc(name, args) {
        if (name !== 'establish_funding_settings') return { data: null, error: { message: 'wrong RPC' } };
        if (shouldFail) {
          shouldFail = false;
          return { data: null, error: { message: 'network unavailable' } };
        }
        // The mock has the same write-once behavior as INSERT ... ON CONFLICT
        // DO NOTHING followed by a read in the migration function.
        const userId = args.__userId;
        if (!rows.has(userId) && args.p_essential_minor !== null) {
          rows.set(userId, {
            essential_minor: args.p_essential_minor,
            other_minor: args.p_other_minor,
            snapshot_at: args.p_snapshot_at,
          });
        }
        return { data: rows.has(userId) ? [rows.get(userId)] : [], error: null };
      },
    },
  };
}

// Add the auth identity only inside this test transport; the production RPC
// obtains it from auth.uid() and never accepts it as an argument.
function asUser(client, userId) {
  return {
    rpc(name, args) { return client.rpc(name, { ...args, __userId: userId }); },
  };
}

const first = { essentialMinor: 100_000, otherMinor: 500_000, at: '2026-09-01T10:00:00.000Z' };
const second = { essentialMinor: 200_000, otherMinor: 300_000, at: '2026-09-02T10:00:00.000Z' };

const empty = mockFundingServer();
check('an empty device adopts the account snapshot from cloud',
  await syncFundingSnapshot({ client: asUser(empty.client, 'a'), userId: 'a', localSnapshot: null, rememberedOwnerId: null }),
  { skipped: false, snapshot: null, ownerId: null, clearLocal: false, published: false });

const firstPublish = mockFundingServer();
const published = await syncFundingSnapshot({ client: asUser(firstPublish.client, 'a'), userId: 'a', localSnapshot: first, rememberedOwnerId: null });
check('a legacy local setup is established once and gains its owner', published,
  { skipped: false, snapshot: first, ownerId: 'a', clearLocal: false, published: true });
check('an empty second device adopts the established winning snapshot',
  await syncFundingSnapshot({ client: asUser(firstPublish.client, 'a'), userId: 'a', localSnapshot: null, rememberedOwnerId: null }),
  { skipped: false, snapshot: first, ownerId: 'a', clearLocal: false, published: false });
check('a later local value cannot overwrite the established timestamp or amounts',
  await syncFundingSnapshot({ client: asUser(firstPublish.client, 'a'), userId: 'a', localSnapshot: second, rememberedOwnerId: 'a' }),
  { skipped: false, snapshot: first, ownerId: 'a', clearLocal: false, published: false });

const simultaneous = mockFundingServer();
const [one, two] = await Promise.all([
  syncFundingSnapshot({ client: asUser(simultaneous.client, 'a'), userId: 'a', localSnapshot: first, rememberedOwnerId: null }),
  syncFundingSnapshot({ client: asUser(simultaneous.client, 'a'), userId: 'a', localSnapshot: second, rememberedOwnerId: null }),
]);
check('simultaneous first setups converge on the one winning complete snapshot',
  [one.snapshot, two.snapshot, simultaneous.rows.get('a')], [first, first, {
    essential_minor: first.essentialMinor, other_minor: first.otherMinor, snapshot_at: first.at,
  }]);

const retry = mockFundingServer({ fail: true });
let error = null;
try {
  await syncFundingSnapshot({ client: asUser(retry.client, 'a'), userId: 'a', localSnapshot: first, rememberedOwnerId: null });
} catch (err) { error = err.message; }
check('a failed attempt leaves the caller-owned local snapshot eligible for retry', error, 'network unavailable');
check('retry publishes the original timestamp unchanged',
  (await syncFundingSnapshot({ client: asUser(retry.client, 'a'), userId: 'a', localSnapshot: first, rememberedOwnerId: null })).snapshot,
  first);

check('offline or signed-out calls are skipped without a write',
  await syncFundingSnapshot({ client: null, userId: null, localSnapshot: first, rememberedOwnerId: null }),
  { skipped: true, snapshot: null, ownerId: null, clearLocal: false });

const scoped = mockFundingServer();
await syncFundingSnapshot({ client: asUser(scoped.client, 'a'), userId: 'a', localSnapshot: first, rememberedOwnerId: null });
await syncFundingSnapshot({ client: asUser(scoped.client, 'b'), userId: 'b', localSnapshot: second, rememberedOwnerId: null });
check('each authenticated account gets an isolated snapshot',
  [scoped.rows.get('a').essential_minor, scoped.rows.get('b').essential_minor], [100_000, 200_000]);
check('an account switch cannot publish the remembered prior-account snapshot',
  await syncFundingSnapshot({ client: asUser(scoped.client, 'b'), userId: 'b', localSnapshot: first, rememberedOwnerId: 'a' }),
  { skipped: false, snapshot: second, ownerId: 'b', clearLocal: false, published: false });
check('a switched account with no cloud row clears the old local snapshot only after a successful read',
  await syncFundingSnapshot({ client: asUser(scoped.client, 'c'), userId: 'c', localSnapshot: first, rememberedOwnerId: 'a' }),
  { skipped: false, snapshot: null, ownerId: null, clearLocal: true, published: false });

if (failures) process.exitCode = 1;
