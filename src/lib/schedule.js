/* Recurring entries: known charges that come round on their own — rent, a
 * subscription, a salary. The app already *detects* subscriptions from history;
 * this is the other direction, a charge you tell it about up front so it can
 * remind you. When one comes due it drops into the "To be resolved" inbox for a
 * one-tap confirm, which is the honest reminder for an offline app: it never
 * logs money that may not have moved, it just surfaces the thing to check.
 *
 * A schedule is { id, name, amountMinor, direction, category, cadence, nextDue }.
 * Pure date arithmetic here; the store is a plain array in meta.
 */

/** The next occurrence after a given one, one cadence step later. */
export function nextDueAfter(fromISO, cadence) {
  const d = new Date(fromISO);
  if (cadence === 'weekly') d.setDate(d.getDate() + 7);
  else if (cadence === 'fortnightly') d.setDate(d.getDate() + 14);
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
