/* Write-once sync protocol for the two-pot opening snapshot.
 *
 * The server function inserts only when the signed-in user has no row, then
 * returns the row that won.  This makes a simultaneous first setup converge
 * without client clocks or last-write-wins changing an established count.
 */

import { isFundingSnapshot } from '../lib/funding.js';

function fromRemote(row) {
  const snapshot = row && {
    essentialMinor: Number(row.essential_minor),
    otherMinor: Number(row.other_minor),
    at: row.snapshot_at,
  };
  return isFundingSnapshot(snapshot) ? snapshot : null;
}

/**
 * @param {{rpc: Function}|null} client
 * @param {string|null} userId signed-in account id
 * @param {object|null} localSnapshot device snapshot
 * @param {string|null} rememberedOwnerId account that established local data
 */
export async function syncFundingSnapshot({ client, userId, localSnapshot, rememberedOwnerId }) {
  if (!client || !userId) return { skipped: true, snapshot: null, ownerId: null, clearLocal: false };

  const validLocal = isFundingSnapshot(localSnapshot);
  // An account switch must never publish the prior account's locally cached
  // balance. A legacy snapshot with no owner is eligible once, to upgrade it.
  const mayPublish = validLocal && (!rememberedOwnerId || rememberedOwnerId === userId);
  const args = mayPublish
    ? {
        p_essential_minor: localSnapshot.essentialMinor,
        p_other_minor: localSnapshot.otherMinor,
        p_snapshot_at: localSnapshot.at,
      }
    : { p_essential_minor: null, p_other_minor: null, p_snapshot_at: null };

  const { data, error } = await client.rpc('establish_funding_settings', args);
  if (error) throw error;

  const snapshot = fromRemote(Array.isArray(data) ? data[0] : data);
  return {
    skipped: false,
    snapshot,
    ownerId: snapshot ? userId : null,
    // Only clear after a successful read proving this account has no snapshot.
    clearLocal: Boolean(rememberedOwnerId && rememberedOwnerId !== userId && !snapshot),
    published: Boolean(snapshot && mayPublish && !rememberedOwnerId),
  };
}
