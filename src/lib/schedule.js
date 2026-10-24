/* Recurring entries: known charges that come round on their own — rent, a
 * subscription, a salary. When one comes due it drops into the "To be resolved"
 * inbox for a one-tap confirm, which is the honest reminder for an offline app:
 * it never logs money that may not have moved, it just surfaces the thing to
 * check.
 *
 * This list is the *only* source of recurring charges. Detection from history
 * used to feed the allowance directly, and it was wrong often enough to matter:
 * bread bought on the same date two months running read as a monthly bill and
 * was quietly reserved. Now detection only *suggests* — the person says yes,
 * and can say no once and not be asked again.
 *
 * Nor is a bill deducted from what is safe to spend. It has not left yet, and a
 * figure that already assumes it has stops matching the account. Upcoming bills
 * are reported beside the balance instead, with what would be left after them.
 *
 * A schedule is { id, name, amountMinor, direction, category, cadence, nextDue,
 * matchKey? }. `matchKey` is the group key of the purchases a schedule was
 * created from, so a logged payment can be recognised as this bill.
 * Pure date arithmetic here; the store is a plain array in meta.
 */

import { subscriptions } from './insights.js';
import { groupKey } from '../capture/normalize.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const CADENCES = ['monthly', 'fortnightly', 'weekly', 'quarterly'];

/** The next occurrence after a given one, one cadence step later. */
export function nextDueAfter(fromISO, cadence) {
  const d = new Date(fromISO);
  if (cadence === 'weekly') d.setDate(d.getDate() + 7);
  else if (cadence === 'fortnightly') d.setDate(d.getDate() + 14);
  else if (cadence === 'quarterly') d.setMonth(d.getMonth() + 3);
  else d.setMonth(d.getMonth() + 1); // monthly is the default
  return d.toISOString();
}

/** Schedules whose next occurrence has arrived. */
export function dueSchedules(schedules, now = new Date()) {
  const t = now.getTime();
  return (schedules || []).filter((s) => s.nextDue && new Date(s.nextDue).getTime() <= t);
}

/**
 * Move a fired schedule to its next *future* occurrence. It skips straight past
 * any occurrences missed while the app was closed rather than firing a backlog:
 * a reminder for a bill three months stale is noise, and you log what you
 * actually paid, not what the calendar says you should have.
 */
export function advanceSchedule(schedule, now = new Date()) {
  const t = now.getTime();
  let next = schedule.nextDue;
  let guard = 0;
  while (new Date(next).getTime() <= t && guard++ < 600) {
    next = nextDueAfter(next, schedule.cadence);
  }
  return { ...schedule, nextDue: next };
}

/** A stable key for one occurrence, so surfacing it twice lands in the inbox once. */
export function occurrenceKey(schedule) {
  return `sched:${schedule.id}:${String(schedule.nextDue).slice(0, 10)}`;
}

/** The group key a schedule's payments are logged under. */
export function scheduleKey(schedule) {
  return schedule.matchKey || groupKey(schedule.name);
}

/**
 * Bills expected before `until`, one entry per occurrence, soonest first.
 *
 * Only outgoing schedules count — an expected salary is not a bill. An
 * occurrence already paid is dropped: a payment logged under the same name
 * within a week before its due date (or any time since) means the money has
 * already left and is in the balance, and listing it again would count it
 * twice. An occurrence overdue but not yet paid stays — it is still owed.
 */
export function upcomingBills(schedules, rows = [], { now = new Date(), until } = {}) {
  const nowMs = now.getTime();
  const untilMs = new Date(until).getTime();
  const out = [];

  for (const s of schedules || []) {
    if (s.direction === 'in' || !s.nextDue || !(s.amountMinor > 0)) continue;
    const key = scheduleKey(s);
    const paidAt = (rows || [])
      .filter((r) => !r.deleted && r.direction === 'out' && groupKey(r.raw_name) === key)
      .map((r) => new Date(r.occurred_at).getTime());

    let due = s.nextDue;
    let guard = 0;
    while (new Date(due).getTime() <= untilMs && guard++ < 60) {
      const dueMs = new Date(due).getTime();
      const paid = paidAt.some((t) => t >= dueMs - 7 * DAY_MS && t <= nowMs);
      if (!paid) {
        out.push({
          id: s.id,
          name: s.name,
          amountMinor: s.amountMinor,
          category: s.category || null,
          cadence: s.cadence,
          dueAt: due,
          overdue: dueMs <= nowMs,
        });
      }
      due = nextDueAfter(due, s.cadence);
    }
  }

  return out.sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1));
}

/* Categories where a repeat on a cycle is the normal shape of the spending, so
 * two matching charges are enough to ask. Anywhere else — groceries, eating
 * out — two purchases a month apart are coincidence far more often than a bill,
 * and it takes three before the question is worth interrupting for. */
const BILL_CATEGORIES = new Set(['Subscriptions', 'Utilities', 'Rent', 'Education']);

/**
 * Charges that look recurring and that the person has not yet answered for.
 *
 * Deliberately stricter than `subscriptions`, which is a report: this one
 * interrupts, so a false positive costs attention. Lapsed series, ones already
 * tracked and ones dismissed are all left out.
 */
export function recurringSuggestions(rows, schedules = [], dismissed = [], { now = new Date() } = {}) {
  const tracked = new Set((schedules || []).map(scheduleKey));
  const skip = new Set(dismissed || []);
  const live = (rows || []).filter((r) => !r.deleted && r.source !== 'bluecoins');

  return subscriptions(live, { now })
    .filter((s) => !s.lapsed && !tracked.has(s.key) && !skip.has(s.key))
    .map((s) => {
      const latest = live
        .filter((r) => r.direction === 'out' && groupKey(r.raw_name) === s.key)
        .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))[0];
      return { ...s, category: latest?.category || null };
    })
    .filter((s) => {
      if (BILL_CATEGORIES.has(s.category)) return true;
      // Elsewhere: three or more, at a steady price.
      return s.count >= 3 && s.minMinor / s.maxMinor >= 0.85;
    });
}

/** A schedule for an accepted suggestion, due next at its first future cycle. */
export function scheduleFromSuggestion(suggestion, { id, now = new Date() } = {}) {
  const schedule = {
    id,
    name: suggestion.label,
    amountMinor: suggestion.lastMinor,
    direction: 'out',
    category: suggestion.category || null,
    cadence: CADENCES.includes(suggestion.cadence) ? suggestion.cadence : 'monthly',
    nextDue: suggestion.nextDue,
    matchKey: suggestion.key,
  };
  return new Date(schedule.nextDue).getTime() <= now.getTime() ? advanceSchedule(schedule, now) : schedule;
}
