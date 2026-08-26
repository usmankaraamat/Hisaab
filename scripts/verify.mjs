/* Node-side checks for the pure logic: the one-line parser and the Bluecoins
 * importer. Run with `npm run verify`.
 *
 * The importer, prediction and insight assertions are pinned to a real 3-month
 * export, so a regression shows up as a total that no longer reconciles rather
 * than as silently wrong data.
 *
 * That export is personal financial data and is deliberately not in the repo.
 * When TransactionsLatest.csv is absent — CI, or a fresh clone — those sections
 * are skipped and the pure-logic checks still run. Drop the file in the repo
 * root to get the full suite.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseEntry } from '../src/capture/parse.js';
import { parseBluecoins } from '../src/import/bluecoins.js';
import { stableId } from '../src/db/local.js';
import { formatMinor } from '../src/lib/money.js';
import { parseRoute, groupKey, displayName, templateText } from '../src/capture/normalize.js';
import { planEntry } from '../src/capture/split.js';
import { balances, ledgerTotals } from '../src/lib/ledger.js';
import { budgetSummary, categoryTotals, categoryBudgets, calendarPeriod, spendPace, ON_OTHERS, RECONCILE } from '../src/lib/budget.js';
import { findDuplicate } from '../src/lib/dupes.js';
import {
  barLayout, gridLines, ceilNice, shortMinor, FRAME,
  bridgeLayout, divergingLayout, sparkPoints, linePoints,
} from '../src/lib/chart.js';
import {
  monthlySeries, weeklySeries, dailySeries, weeksIn, savingsPot, savingsRate,
  projectMonth, categoryDelta, categorySeries, suggestedTarget, goalProgress, isTracked, isSpend,
} from '../src/lib/trends.js';
import { txnLabel, hasRewrite, ledgerLabel } from '../src/lib/label.js';
import { rankSuggestions } from '../src/capture/predict.js';
import { parseNotification } from '../src/capture/notif.js';
import { matchRule, ruleFields, suggestMatch } from '../src/lib/rules.js';
import { nextDueAfter, dueSchedules, advanceSchedule, occurrenceKey } from '../src/lib/schedule.js';
import {
  rideSurge,
  priceIndex,
  subscriptions,
  monthlyTotals,
  surgeCheck,
} from '../src/lib/insights.js';

const here = dirname(fileURLToPath(import.meta.url));

let fails = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        got      ${JSON.stringify(actual)}`);
    console.log(`        expected ${JSON.stringify(expected)}`);
  }
}

console.log('--- parseEntry ---');
const p = (s) => {
  const r = parseEntry(s);
  return [r.name, r.amountMinor, r.direction];
};

check('chicken 900', p('chicken 900'), ['chicken', 90000, 'out']);
check('900 chicken', p('900 chicken'), ['chicken', 90000, 'out']);
check('decimal', p('yogurt 62.50'), ['yogurt', 6250, 'out']);
check('comma grouping', p('Loan to Khuzaima 40,000'), ['Loan to Khuzaima', 4000000, 'out']);
check('k suffix', p('rent 25k'), ['rent', 2500000, 'out']);
check('leading + is income', p('Salary +150000'), ['Salary', 15000000, 'in']);
check('digits inside name', p('Indrive F10-26 Number 450'), ['Indrive F10-26 Number', 45000, 'out']);
check('name ending in a word', p('Indrive F10-26 Number'), ['Indrive F10-26 Number', null, 'out']);
check('leading digits in name', p("26 Number - Anser's Home 250"), [
  "26 Number - Anser's Home",
  25000,
  'out',
]);
check('collapses whitespace', p('  Diet   Coke   100  '), ['Diet Coke', 10000, 'out']);
check('empty input', p(''), ['', null, 'out']);
check('amount only', p('300'), ['', 30000, 'out']);

console.log('\n--- parseNotification (real wallet/bank formats) ---');
const notif = (text, app) => {
  const r = parseNotification(text, { appName: app });
  return r && [r.amountMinor, r.direction, r.counterparty, r.source, r.occurredAt];
};
check('easypaisa received (fee line ignored)',
  notif('Trx ID 53945346065. You have Received Rs. 50.00 from , Bank BAF in your Easypaisa Account. Fee for this transaction is Rs. 0.00.', 'easypaisa'),
  [5000, 'in', 'Bank BAF', 'easypaisa', null]);
check('Bank Alfalah sent, with date',
  notif('Transaction Alert PKR 50.00 sent to MALIK USMAN KARAMAT TMB from your BAF A/C **9388 on 10-Aug-26 14:23:57 via FT Tx ID FT262220PL86PYMF', 'Alfa'),
  [5000, 'out', 'MALIK USMAN KARAMAT', 'Bank Alfalah', '2026-08-10T14:23:57.000Z']);
check('NayaPay sent (no amount decimals)',
  notif("Off it goes Rs. 10 sent to Usman Karamat. Your wallet's seen better days.", 'NayaPay'),
  [1000, 'out', 'Usman Karamat', 'NayaPay', null]);
check('easypaisa Raast sent, ISO date',
  notif('Dear MALIK USMAN KARAMAT, An amount of Rs. 675.0 has been successfully sent to AWAIS IQBAL in *******3787 via Raast Payment from your Easypaisa account *****19 on 2026-08-09 at 14:18:28.404552834. Trx ID 3945073211.', 'easypaisa'),
  [67500, 'out', 'AWAIS IQBAL', 'easypaisa', '2026-08-09T14:18:28.000Z']);
check('HBL SMS received, day-first date',
  notif('PKR 10.00 received from MALIK USMAN KARAMAT IBAN in your HBL A/C via your Raast ID on 09/08/2026 14:24:13 TXN ID SM091424115A8429.', '14250'),
  [1000, 'in', 'MALIK USMAN KARAMAT', 'HBL', '2026-08-09T14:24:13.000Z']);
check('a message with no amount is not a capture',
  parseNotification('Your OTP is 4821, do not share it with anyone.'), null);
check('a fee-only line does not log zero',
  parseNotification('Fee for this transaction is Rs. 0.00.'), null);

const csvPath = join(here, '..', 'TransactionsLatest.csv');
const hasCsv = existsSync(csvPath);

let inputs = [];
let summary = null;

if (hasCsv) {
console.log('\n--- parseBluecoins against the real export ---');
const parsed = parseBluecoins(readFileSync(csvPath, 'utf8'));
({ inputs, summary } = parsed);
const errors = parsed.errors;

check('row count', summary.count, 397);
check('parse errors', errors.length, 0);
check('days covered', summary.days, 91);
check('earliest date', summary.min.slice(0, 10), '2026-05-04');
check('latest date', summary.max.slice(0, 10), '2026-08-03');
check('total spent (minor)', summary.spentMinor, 52333900);
check('total received (minor)', summary.receivedMinor, 62408100);
check('expense rows', inputs.filter((i) => i.direction === 'out').length, 384);
check('income rows', inputs.filter((i) => i.direction === 'in').length, 13);
check(
  'idempotency keys unique',
  new Set(inputs.map((i) => i.client_event_id)).size,
  397
);
check('raw_name preserved verbatim', inputs[0].raw_name, 'Eat Out');

console.log(`\n  spent    ${formatMinor(summary.spentMinor)}`);
console.log(`  received ${formatMinor(summary.receivedMinor)}`);
console.log(`  range    ${summary.min.slice(0, 10)} -> ${summary.max.slice(0, 10)} (${summary.days} days)`);
}

console.log('\n--- cross-device import ids ---');
// Two devices importing the same export must converge on one row, or the second
// device's push collides with the (user_id, client_event_id) unique index and
// aborts the sync loop.
const key = 'bluecoins:2026-08-03 20:51:39.478|Eat Out|-550.00';
const idA = await stableId(key);
const idB = await stableId(key);
check('same import key gives the same id on both devices', idA, idB);
check('a different key gives a different id', (await stableId(key + 'x')) !== idA, true);
check('the id is a valid v5-shaped uuid',
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idA), true);

console.log('\n--- shared expenses ---');
// "cake for tom, dick, harry 2500" has to become three rows that add back up to
// 2500, none of it charged to the user, and each owed by one person.
const cake = planEntry('cake for tom, dick, harry', 250000, 'out', { knownPeople: [] });
check('three names split three ways', cake.rows.length, 3);
check('splits automatically on a list of names', cake.auto, true);
check('the shares add back up to the amount typed',
  cake.rows.reduce((a, r) => a + r.amount_minor, 0), 250000);
check('the remainder is not lost to integer division',
  cake.rows.map((r) => r.amount_minor), [83334, 83333, 83333]);
check('every share is owed back', cake.rows.every((r) => r.ledger_effect === 'lent'), true);
check('each row names its person',
  cake.rows.map((r) => r.counterparty_name), ['Tom', 'Dick', 'Harry']);
check('each row reads as what it is', cake.rows[0].raw_name, 'cake for Tom');
check('no share is charged to the user', cake.includesMe, false);

const withMe = planEntry('cake for tom, dick, harry, me', 250000, 'out', { knownPeople: [] });
check('naming yourself adds a fourth share', withMe.rows.length, 4);
check('your share is an ordinary expense',
  [withMe.rows[3].counterparty_name, withMe.rows[3].ledger_effect], [null, null]);
check('the total is still exactly what was typed',
  withMe.rows.reduce((a, r) => a + r.amount_minor, 0), 250000);

// A single unfamiliar name is offered, not applied — otherwise "charger for
// laptop" invents a person called Laptop.
const unknownOne = planEntry('pizza for sister', 55000, 'out', { knownPeople: [] });
check('one unknown name is proposed rather than split', unknownOne.auto, false);
check('one KNOWN name splits on its own',
  planEntry('pizza for sister', 55000, 'out', { knownPeople: ['Sister'] }).auto, true);
check('name matching ignores case',
  planEntry('pizza for SISTER', 55000, 'out', { knownPeople: ['sister'] }).auto, true);

check('a bracketed aside is the same thing',
  planEntry('Slanty(for sis)', 12000, 'out', { knownPeople: ['Sis'] })?.rows[0].counterparty_name, 'Sis');
check('a bare bracketed name works too',
  planEntry('Internet Bundle(Uzair)', 50000, 'out', { knownPeople: ['Uzair'] })?.rows[0].counterparty_name, 'Uzair');

check('an ordinary entry is left alone', planEntry('chicken', 90000, 'out'), null);
check('a route is never read as a person',
  planEntry('Indrive Home - Office', 20000, 'out', { knownPeople: ['Office'] }), null);
check('digits disqualify a name',
  planEntry('ticket for 2 people', 50000, 'out'), null);
check('"+" joins things, it does not separate people',
  planEntry('Anser Farewell + Oil Spray Bottle', 50000, 'out', { knownPeople: ['Anser'] }), null);
check('incoming money is never a purchase on someone else’s behalf',
  planEntry('gift for sister', 50000, 'in', { knownPeople: ['Sister'] }), null);

const back = planEntry('reimbursement from tom', 50000, 'out', { knownPeople: [] });
check('a reimbursement is incoming money', back.rows[0].direction, 'in');
check('a reimbursement cancels a due', back.rows[0].ledger_effect, 'repaid_by');
check('a reimbursement names the payer', back.rows[0].counterparty_name, 'Tom');
check('a reimbursement is categorised at capture', back.rows[0].category, 'Reimbursement');
check('a single reimbursement keeps the text typed', back.rows[0].raw_name, 'reimbursement from tom');
check('"paid back by" is the same thing',
  planEntry('paid back by tom', 50000, 'out')?.rows[0].ledger_effect, 'repaid_by');
check('a reimbursement with no person is not one',
  planEntry('Security Reimbursement', 50000, 'in'), null);

console.log('\n--- ledger balances ---');
const owed = (name, effect, minor, extra = {}) => ({
  raw_name: name,
  counterparty_name: name,
  ledger_effect: effect,
  amount_minor: minor,
  direction: effect === 'lent' || effect === 'repaid_to' ? 'out' : 'in',
  occurred_at: '2026-08-01T10:00:00.000Z',
  deleted: 0,
  ...extra,
});

const book = balances([
  owed('Tom', 'lent', 83334),
  owed('Tom', 'repaid_by', 50000),
  owed('Dick', 'lent', 83333),
  owed('Harry', 'lent', 83333),
  owed('Harry', 'repaid_by', 83333),
  owed('Khuzaima', 'borrowed', 2500000),
]);
const who = (n) => book.find((p) => p.name === n);
check('a part payment leaves the remainder', who('Tom').netMinor, 33334);
check('paying in full squares up', who('Harry').netMinor, 0);
check('borrowing shows as money you owe', who('Khuzaima').netMinor, -2500000);
check('the largest balance sorts first', book[0].name, 'Khuzaima');
check('rows with no ledger effect are ignored',
  balances([{ raw_name: 'chicken', amount_minor: 90000, direction: 'out', deleted: 0 }]).length, 0);
check('a deleted row stops counting',
  balances([owed('Tom', 'lent', 50000, { deleted: 1 })]).length, 0);
check('a written-off row keeps its history but not its balance',
  balances([owed('Tom', 'lent', 50000, { ledger_settled: 1 })])[0].netMinor, 0);
check('"tom" and "Tom" are one person',
  balances([owed('tom', 'lent', 50000), owed('Tom', 'repaid_by', 20000)]).length, 1);

const totals = ledgerTotals(book);
check('totals separate the two directions',
  [totals.owedToMeMinor, totals.iOweMinor], [116667, 2500000]);

console.log('\n--- bought FROM someone: they paid, so it is owed back ---');
const fromHarry = planEntry('chicken piece from Harry', 50000, 'out', { knownPeople: ['Harry'] });
check('"from" opens a debt the other way', fromHarry.rows[0].ledger_effect, 'borrowed');
check('"from" names the payer', fromHarry.rows[0].counterparty_name, 'Harry');
check('a purchase someone else funded is still an expense', fromHarry.rows[0].direction, 'out');
check('the category is left to enrichment', fromHarry.rows[0].category, null);
check('one row, not a split', fromHarry.rows.length, 1);
check('an unfamiliar payer is offered, not applied',
  planEntry('chicken from Metro', 50000, 'out', { knownPeople: [] }).auto, false);
check('a known payer applies on its own',
  planEntry('chicken from Harry', 50000, 'out', { knownPeople: ['harry'] }).auto, true);

const cashLoan = planEntry('Loan from Khuzaima', 2500000, 'out', { knownPeople: [] });
check('a cash loan is money arriving', cashLoan.rows[0].direction, 'in');
check('a cash loan is still borrowed', cashLoan.rows[0].ledger_effect, 'borrowed');
check('a cash loan needs no confirmation', cashLoan.auto, true);
check('a cash loan is categorised at capture', cashLoan.rows[0].category, 'Transfers & Loans');
check('a reimbursement is not read as a purchase from someone',
  planEntry('reimbursement from tom', 50000, 'out').kind, 'reimbursement');
check('a route is never read as buying from a person',
  planEntry('Indrive Home - Office from Gym', 20000, 'out', { knownPeople: [] }), null);
check('two payers is too ambiguous to guess',
  planEntry('cake from tom and dick', 50000, 'out', { knownPeople: ['Tom', 'Dick'] }), null);

console.log('\n--- what is left ---');

/* The scenario is the live data in miniature, because the live data is what
 * exposed the problem: of 121,676 "spent", 83,300 was an investment, a
 * remittance and a loan. Every assertion below is about keeping those apart. */
const spend = (over) => ({
  raw_name: 'x',
  amount_minor: 0,
  direction: 'out',
  occurred_at: '2026-08-05T10:00:00.000Z',
  category: null,
  deleted: 0,
  ...over,
});

const ledgerJuly = [
  spend({ raw_name: 'Salary', direction: 'in', amount_minor: 13000000, category: 'Income',
          occurred_at: '2026-08-03T13:00:00.000Z' }),
  spend({ raw_name: 'chicken', amount_minor: 100000, category: 'Groceries' }),
  spend({ raw_name: 'Investment', amount_minor: 5000000, category: 'Savings' }),
  spend({ raw_name: 'cake for Tom', amount_minor: 44000, category: 'Eating Out',
          counterparty_name: 'Tom', ledger_effect: 'lent' }),
  spend({ raw_name: 'chicken piece from Harry', amount_minor: 50000, category: 'Eating Out',
          counterparty_name: 'Harry', ledger_effect: 'borrowed' }),
  // Before the salary, so the period must not see it at all.
  spend({ raw_name: 'old thing', amount_minor: 900000, category: 'Shopping',
          occurred_at: '2026-07-30T10:00:00.000Z' }),
];

const asOfAug8 = new Date('2026-08-08T12:00:00.000Z');
const b = budgetSummary(ledgerJuly, { now: asOfAug8 });

// August 2026 opens on a Saturday, so the period starts the following Monday.
check('the period starts at the first weekday of the month', b.since, '2026-08-03T00:00:00.000Z');
check('the period runs to the first weekday of the next month',
  b.nextIncomeAt.slice(0, 10), '2026-09-01');
check('spending before the period is excluded', b.spendMinor, 100000);
check('an investment is not spending', b.savedMinor, 5000000);
check('money lent out is not spending', b.lentOutMinor, 44000);
check('a purchase someone else paid for is not spending', b.fundedByOthersMinor, 50000);
check('and it is a debt', b.iOweMinor, 50000);
// 13,000,000 in, less 100,000 + 5,000,000 + 44,000 out. The 50,000 Harry paid
// never touched the wallet, and the July row is outside the period.
check('cash counts everything that actually moved', b.cashMinor, 7856000);
check('what you owe is subtracted from what is safe to spend',
  b.safeToSpendMinor, 7856000 - 50000);
check('and what is owed to you is not added to it', b.owedToMeMinor, 44000);
// Aug 8 12:00 to Sep 1 00:00 is 23 days and a half, and a part day still has
// to be spent through, so it rounds up.
check('the allowance divides by the days remaining', b.daysLeft, 24);
check('the allowance is quoted in whole rupees', b.dailyMinor, 325200);

const saving = budgetSummary(ledgerJuly, { savingsTargetMinor: 6000000, now: asOfAug8 });
check('a savings target is deducted before the allowance, not after',
  saving.safeToSpendMinor, 7856000 - 1000000 - 50000);
check('and only the part not yet saved', saving.savingsRemainingMinor, 1000000);
check('a met target takes nothing further',
  budgetSummary(ledgerJuly, { savingsTargetMinor: 4000000, now: asOfAug8 }).savingsRemainingMinor, 0);

const withOpening = budgetSummary(ledgerJuly, {
  opening: { amountMinor: 2000000, at: '2026-08-06T00:00:00.000Z' },
  now: asOfAug8,
});
check('an opening balance set inside the period overrides the month anchor',
  withOpening.anchoredTo, 'opening');
check('and rows before it stop counting', withOpening.cashMinor, 2000000);
check('an opening balance before the period defers to the month anchor',
  budgetSummary(ledgerJuly, {
    opening: { amountMinor: 2000000, at: '2026-08-01T00:00:00.000Z' },
    now: asOfAug8,
  }).anchoredTo, 'calendar');
check('with no income and no opening there is nothing to report',
  budgetSummary([spend({ amount_minor: 5000 })], { now: asOfAug8 }).anchoredTo, 'none');

const cats = categoryTotals(ledgerJuly, { from: b.since });
check('the breakdown reconciles with total spend',
  cats.reduce((a, c) => a + c.totalMinor, 0), b.spendMinor);
check('savings never appears as a spending category',
  cats.some((c) => c.category === 'Savings'), false);
check('an uncategorised row is reported, not dropped',
  categoryTotals([spend({ amount_minor: 700 })])[0].category, 'Uncategorised');

console.log('\n--- capture rules ---');
const ruleset = [
  { id: '1', match: 'indrive', category: 'Rides' },
  { id: '2', match: 'k-electric', category: 'Utilities' },
];
check('a rule matches on a contained word',
  matchRule(ruleset, 'Indrive Home-Office')?.category, 'Rides');
check('matching is case-insensitive', matchRule(ruleset, 'INDRIVE flat')?.category, 'Rides');
check('an unmatched name yields no rule', matchRule(ruleset, 'chicken karahi'), null);
check('the first matching rule wins',
  matchRule([{ match: 'a', category: 'X' }, { match: 'app', category: 'Y' }], 'apple')?.category, 'X');
check('a rule contributes only a category', ruleFields(ruleset[0]), { category: 'Rides' });
check('a suggested match is the first word', suggestMatch('Indrive Home-Office'), 'indrive');

console.log('\n--- recurring schedules ---');
check('a monthly schedule steps by a month',
  nextDueAfter('2026-01-15T09:00:00.000Z', 'monthly').slice(0, 10), '2026-02-15');
check('a weekly one steps by seven days',
  nextDueAfter('2026-01-15T09:00:00.000Z', 'weekly').slice(0, 10), '2026-01-22');
const scheds = [
  { id: 'rent', name: 'Rent', amountMinor: 2500000, direction: 'out', cadence: 'monthly', nextDue: '2026-08-01T09:00:00.000Z' },
  { id: 'gym', name: 'Gym', amountMinor: 300000, direction: 'out', cadence: 'monthly', nextDue: '2026-09-20T09:00:00.000Z' },
];
check('only a due schedule surfaces',
  dueSchedules(scheds, asOfAug8).map((s) => s.id), ['rent']);
// Dormant since 1 Aug: advancing past 8 Aug lands on 1 Sep, not a backlog of one per month.
check('a due schedule advances to its next future occurrence',
  advanceSchedule(scheds[0], asOfAug8).nextDue.slice(0, 10), '2026-09-01');
check('an occurrence key is stable per due date',
  occurrenceKey(scheds[0]), 'sched:rent:2026-08-01');

console.log('\n--- per-category budgets ---');
const budgetRows = [
  spend({ raw_name: 'chicken', amount_minor: 120000, category: 'Groceries' }),
  spend({ raw_name: 'more groceries', amount_minor: 40000, category: 'Groceries' }),
  spend({ raw_name: 'burger', amount_minor: 90000, category: 'Eating Out' }),
];
const cb = categoryBudgets(budgetRows, { Groceries: 100000, 'Eating Out': 200000, Rent: 5000000 });
check('a budget reports what is spent against it',
  cb.find((c) => c.category === 'Groceries').spentMinor, 160000);
check('and flags going over', cb.find((c) => c.category === 'Groceries').over, true);
check('an under-budget category is not over',
  cb.find((c) => c.category === 'Eating Out').over, false);
check('the closest to its cap leads', cb[0].category, 'Groceries');
check('a category with no spend still shows its cap',
  cb.find((c) => c.category === 'Rent').spentMinor, 0);
check('a zero cap is ignored', categoryBudgets(budgetRows, { Groceries: 0 }).length, 0);

console.log('\n--- the period is the calendar month, and reconciling does not move it ---');

check('a month opening on a weekday starts on the 1st',
  calendarPeriod(new Date('2026-09-15T12:00:00.000Z')).periodStart, '2026-09-01T00:00:00.000Z');
check('and runs to the 1st of the next month',
  calendarPeriod(new Date('2026-09-15T12:00:00.000Z')).periodEnd, '2026-10-01T00:00:00.000Z');
check('a month opening on a weekend starts on the first Monday',
  calendarPeriod(new Date('2026-11-15T12:00:00.000Z')).periodStart, '2026-11-02T00:00:00.000Z');
check("a day before this month's start weekday still belongs to last period",
  calendarPeriod(new Date('2026-11-01T09:00:00.000Z')).periodStart, '2026-10-01T00:00:00.000Z');

/* Reconciling used to re-stamp the opening balance, which reset the period and
 * dropped the salary out of it — the source of the negative balances. Now it
 * writes one honest "Reconcile cash" row: cash moves to what was counted, the
 * period stays put, and the correction is kept out of income, spend and the
 * breakdown, because it is not something earned or bought. */
const recon = [
  spend({ raw_name: 'Salary', direction: 'in', amount_minor: 10000000, category: 'Income',
          occurred_at: '2026-08-03T13:00:00.000Z' }),
  spend({ raw_name: 'chicken', amount_minor: 100000, category: 'Groceries' }),
  // Held more than tracked: a correction credit.
  spend({ raw_name: 'Reconcile cash', direction: 'in', amount_minor: 30000, category: RECONCILE }),
  // Held less than tracked, another day: a correction charge.
  spend({ raw_name: 'Reconcile cash', amount_minor: 5000, category: RECONCILE,
          occurred_at: '2026-08-06T10:00:00.000Z' }),
];
const rb = budgetSummary(recon, { now: asOfAug8 });
check('a reconciliation moves cash to what was counted',
  rb.cashMinor, 10000000 + 30000 - 100000 - 5000);
check('but a correction is not counted as income', rb.incomeMinor, 10000000);
check('nor as spending', rb.spendMinor, 100000);
check('and never appears in the breakdown',
  categoryTotals(recon, { from: rb.since }).some((c) => c.category === RECONCILE), false);

console.log('\n--- what you spent on others, and what is merely owed ---');

/* One number, one home. Anything still owed is an asset the Ledger tracks and
 * appears nowhere in Spending; anything written off has stopped being a balance
 * and become an expense, so it appears in Spending under a single heading and
 * nowhere else. The previous design showed both on both screens, netted by
 * different rules, and one sister read as 4,050 on one and 4,600 on the other. */
const forOthers = (who, minor, cat, extra = {}) => spend({
  raw_name: `${cat} for ${who}`, amount_minor: minor, category: cat,
  counterparty_name: who, ledger_effect: 'lent', ...extra,
});

const mine = [
  spend({ raw_name: 'Salary', direction: 'in', amount_minor: 13000000, category: 'Income',
          occurred_at: '2026-08-03T13:00:00.000Z' }),
  spend({ raw_name: 'chicken', amount_minor: 100000, category: 'Groceries' }),
  // Still owed, so not an expense at all.
  forOthers('Sister', 31000, 'Groceries'),
  // Written off: it has stopped being a balance and become spending.
  forOthers('Mother', 84000, 'Health', { ledger_settled: 1 }),
  // Tagged with a person but never a debt, which is how a farewell present lands.
  spend({ raw_name: 'Anser Farewell', amount_minor: 50000, category: 'Shopping',
          counterparty_name: 'Anser' }),
  // They paid for this one, so it is on no list of yours.
  spend({ raw_name: 'lunch from Khuzaima', amount_minor: 60000, category: 'Eating Out',
          counterparty_name: 'Khuzaima', ledger_effect: 'borrowed' }),
];

const sp = budgetSummary(mine, { now: asOfAug8 });
check('your own spending is only your own', sp.personalMinor, 100000);
check('written off on other people is one figure', sp.onOthersMinor, 84000 + 50000);
check('what is still owed is not spending', sp.lentOutMinor, 31000);
check('and is excluded from the period total', sp.spendMinor, 100000 + 84000 + 50000);
check('a purchase they funded is on neither list', sp.fundedByOthersMinor, 60000);

const mineCats = categoryTotals(mine, { from: sp.since });
const byName = (n) => mineCats.find((c) => c.category === n)?.totalMinor ?? 0;
check('the breakdown reconciles with what the period cost',
  mineCats.reduce((a, c) => a + c.totalMinor, 0), sp.spendMinor);
check('everything on other people collapses to one heading',
  byName(ON_OTHERS), sp.onOthersMinor);
check('and is not spread through your categories',
  [byName('Health'), byName('Shopping')], [0, 0]);
check('your own category keeps only your own row', byName('Groceries'), 100000);
check('a row still owed appears in no category',
  mineCats.some((c) => c.totalMinor === 31000), false);

// Writing a row off moves it across the line; nothing else about it changes.
const written = mine.map((r) =>
  r.counterparty_name === 'Sister' ? { ...r, ledger_settled: 1 } : r
);
const after = budgetSummary(written, { now: asOfAug8 });
check('writing off turns an owed row into an expense',
  [after.lentOutMinor, after.onOthersMinor], [0, 31000 + 84000 + 50000]);
check('and leaves your own spending alone', after.personalMinor, sp.personalMinor);

console.log('\n--- balances are netted per person, not summed gross ---');

/* The bug this replaces, from the live data: one sister lent 6,570, borrowed 550
 * from and repaid 1,400 by appeared as "owed back 6,570" AND "you owe 550" —
 * two lines about one person — while a friend who had settled in full still
 * showed his original loan, because repayments were never subtracted at all. */
const sister = (effect, minor, extra = {}) => ({
  raw_name: 'x', counterparty_name: 'Sister', ledger_effect: effect, amount_minor: minor,
  direction: effect === 'lent' || effect === 'repaid_to' ? 'out' : 'in',
  occurred_at: '2026-08-10T10:00:00.000Z', category: 'Groceries', deleted: 0, ...extra,
});

const mixed = [
  spend({ raw_name: 'Salary', direction: 'in', amount_minor: 13000000, category: 'Income',
          occurred_at: '2026-08-03T13:00:00.000Z' }),
  sister('lent', 657000),
  // She bought something for me: an outgoing row she funded.
  sister('borrowed', 55000, { direction: 'out' }),
  sister('repaid_by', 140000),
  // Squared up in full, so he must disappear from both totals.
  { raw_name: 'cake for Jahangir', counterparty_name: 'Jahangir', ledger_effect: 'lent',
    amount_minor: 44000, direction: 'out', occurred_at: '2026-08-04T10:00:00.000Z', deleted: 0 },
  { raw_name: 'Reimbursement from Jahangir', counterparty_name: 'Jahangir', ledger_effect: 'repaid_by',
    amount_minor: 44000, direction: 'in', occurred_at: '2026-08-04T11:00:00.000Z', deleted: 0 },
];

const net = budgetSummary(mixed, { now: asOfAug8 });
check('one person nets to one figure', net.owedToMeMinor, 657000 - 55000 - 140000);
check('and does not also appear on the other line', net.iOweMinor, 0);
check('someone who has settled up is gone from the totals',
  net.people.filter((x) => x.netMinor !== 0).map((x) => x.name), ['Sister']);
check('the Spending totals match the Ledger totals exactly',
  [net.owedToMeMinor, net.iOweMinor],
  [ledgerTotals(balances(mixed)).owedToMeMinor, ledgerTotals(balances(mixed)).iOweMinor]);

// Reversed: she is owed overall, so the debt is the one that must be subtracted.
const iOwe = budgetSummary(
  [mixed[0], sister('borrowed', 200000, { direction: 'out' }), sister('lent', 50000)],
  { now: asOfAug8 }
);
check('a net debt subtracts from what is safe to spend',
  [iOwe.iOweMinor, iOwe.owedToMeMinor], [150000, 0]);
check('a debt from before this period still counts',
  budgetSummary([mixed[0], sister('borrowed', 90000, { direction: 'out',
    occurred_at: '2026-07-02T10:00:00.000Z' })], { now: asOfAug8 }).iOweMinor, 90000);
check('a written-off row leaves the totals alone',
  budgetSummary([mixed[0], sister('lent', 90000, { ledger_settled: 1 })],
    { now: asOfAug8 }).owedToMeMinor, 0);

console.log('\n--- money moved in and out of savings ---');

/* Savings is the one category where money comes back. Counting only the
 * deposits reported 50,000 saved after 10,000 had been taken out again, which
 * makes a savings target impossible to trust — the number only ever grew. */
const pot = (dir, minor, at) => spend({
  raw_name: dir === 'in' ? 'Cashed Savings' : 'Investment',
  direction: dir, amount_minor: minor, category: 'Savings', occurred_at: at,
});

const potRows = [
  spend({ raw_name: 'Salary', direction: 'in', amount_minor: 13000000, category: 'Income',
          occurred_at: '2026-08-03T13:00:00.000Z' }),
  pot('out', 5000000, '2026-08-03T14:00:00.000Z'),
  pot('in', 1000000, '2026-08-06T10:00:00.000Z'),
];
const potSummary = budgetSummary(potRows, { savingsTargetMinor: 5000000, now: asOfAug8 });
check('a withdrawal reduces what has been saved', potSummary.savedMinor, 4000000);
check('and reopens the gap to the target', potSummary.savingsRemainingMinor, 1000000);
check('taking your own money back is not income', potSummary.incomeMinor, 13000000);
check('but it is still cash in hand', potSummary.cashMinor, 13000000 - 5000000 + 1000000);
check('withdrawing more than was put in this period goes negative',
  budgetSummary([potRows[0], pot('in', 1000000, '2026-08-06T10:00:00.000Z')],
    { now: asOfAug8 }).savedMinor, -1000000);
check('a savings withdrawal is not spending',
  categoryTotals(potRows).some((c) => c.category === 'Savings'), false);


console.log('\n--- time series, and what may be compared with what ---');

const on = (iso, over = {}) => spend({ occurred_at: iso, ...over });

const history = [
  // Imported: kept for reference, never mixed into a figure that means something.
  on('2026-07-10T10:00:00.000Z', { amount_minor: 900000, category: 'Groceries', source: 'bluecoins' }),
  on('2026-08-03T13:00:00.000Z', { raw_name: 'Salary', direction: 'in',
      amount_minor: 13000000, category: 'Income' }),
  on('2026-08-03T14:00:00.000Z', { raw_name: 'Investment', amount_minor: 5000000, category: 'Savings' }),
  on('2026-08-05T10:00:00.000Z', { amount_minor: 100000, category: 'Groceries' }),
  on('2026-08-09T10:00:00.000Z', { amount_minor: 870000, category: 'Utilities' }),
  on('2026-08-12T10:00:00.000Z', { amount_minor: 200000, category: 'Rides' }),
  on('2026-08-20T10:00:00.000Z', { raw_name: 'Redeemed', direction: 'in',
      amount_minor: 1000000, category: 'Savings' }),
];

const series = monthlySeries(history);
check('one bucket per calendar month', series.map((m) => m.key), ['2026-07', '2026-08']);
check('an imported month is flagged, not hidden',
  series.map((m) => m.reference), [true, false]);
check('spend is money consumed', series[1].spendMinor, 100000 + 870000 + 200000);
check('savings nets deposits against redemptions', series[1].savedMinor, 5000000 - 1000000);
check('fixed and flexible split the spend',
  [series[1].fixedMinor, series[1].flexibleMinor], [870000, 300000]);
check('and add back to it',
  series[1].fixedMinor + series[1].flexibleMinor, series[1].spendMinor);
check('a savings redemption is not income', series[1].incomeMinor, 13000000);

// The export overlaps the first days of the month the app started. A month with
// any tracked rows must describe itself with those, not be greyed out wholesale.
const mixedMonth = [
  on('2026-07-10T10:00:00.000Z', { amount_minor: 900000, category: 'Groceries', source: 'bluecoins' }),
  on('2026-08-02T10:00:00.000Z', { amount_minor: 700000, category: 'Groceries', source: 'bluecoins' }),
  on('2026-08-15T10:00:00.000Z', { amount_minor: 100000, category: 'Groceries' }),
];
const mixedSeries = monthlySeries(mixedMonth);
check('a wholly imported month is reference', mixedSeries[0].reference, true);
check('a month with tracked rows is not', mixedSeries[1].reference, false);
check('and reports only what was tracked', mixedSeries[1].spendMinor, 100000);
check('but says it also holds imported rows', mixedSeries[1].mixed, true);
check('a purely tracked month is neither',
  [mixedSeries[1].mixed, monthlySeries([on('2026-09-01T10:00:00.000Z', { amount_minor: 100 })])[0].mixed],
  [true, false]);


check('savings rate is saved over income', Math.round(savingsRate(series[1]) * 100), 31);
check('no income means no rate, not a zero one', savingsRate(series[0]), null);

/* Weeks are blocks of seven from the 1st, not ISO weeks. An ISO week straddles
 * the month boundary, which would put the same day in two months and stop the
 * weeks adding up to the month above them. */
check('August splits into five blocks', weeksIn(2026, 7).map((w) => [w.start, w.end]),
  [[1, 7], [8, 14], [15, 21], [22, 28], [29, 31]]);
check('February 2026 ends on the 28th', weeksIn(2026, 1).at(-1).end, 28);

const weeks = weeklySeries(history, 2026, 7);
check('the weeks add back up to the month',
  weeks.reduce((a, w) => a + w.spendMinor, 0), series[1].spendMinor);
check('each row lands in exactly one week',
  weeks.map((w) => w.spendMinor), [100000, 870000 + 200000, 0, 0, 0]);

const days = dailySeries(history, 2026, 7, 8, 14);
check('the days add back up to the week',
  days.reduce((a, d) => a + d.spendMinor, 0), weeks[1].spendMinor);
check('a day with nothing in it is still a bar', days.length, 7);

console.log('\n--- the savings pot does not reset ---');

/* The complaint this fixes: a salary landing dropped "saved" back to zero,
 * wiping out months of visible progress. The pot is a running balance driven
 * only by what was logged as savings. */
const potNow = savingsPot(history);
check('every deposit less every withdrawal', potNow.minor, 5000000 - 1000000);
check('counted, both ways', [potNow.deposits, potNow.withdrawals], [1, 1]);
check('income does not touch it',
  savingsPot([...history, on('2026-09-03T10:00:00.000Z', { direction: 'in',
    amount_minor: 13000000, category: 'Income' })]).minor, potNow.minor);
check('nor does spending',
  savingsPot([...history, on('2026-09-04T10:00:00.000Z', { amount_minor: 500000,
    category: 'Rides' })]).minor, potNow.minor);
check('imported savings are reference only, so they stay out of the pot',
  savingsPot([on('2026-07-02T10:00:00.000Z', { amount_minor: 999999,
    category: 'Savings', source: 'bluecoins' })]).minor, 0);
check('provenance is what decides',
  [isTracked({ source: 'manual' }), isTracked({ source: 'bluecoins' })], [true, false]);

const goal = goalProgress(
  { name: 'Laptop', targetMinor: 20000000, byIso: '2027-02-01T00:00:00.000Z' },
  series, { now: new Date('2026-08-22T12:00:00.000Z'), potMinor: potNow.minor }
);
check('the goal measures against the pot', goal.savedMinor, 4000000);
check('and reports what is left', goal.remainingMinor, 16000000);
check('as a percentage', goal.pct, 20);

console.log('\n--- projection and month-over-month ---');

const august = series[1];
const projected = projectMonth(august, new Date('2026-08-22T12:00:00.000Z'));
// 1,170,000 over 22 days, run out to 31.
check('the month is projected from the pace so far',
  projected.spendMinor, Math.round((1170000 / 22) * 31));
check('a finished month is not projected',
  projectMonth(series[0], new Date('2026-08-22T12:00:00.000Z')), null);

const july = { year: 2026, month: 6 };
const withPrior = [
  ...history,
  on('2026-07-11T10:00:00.000Z', { amount_minor: 50000, category: 'Rides' }),
  on('2026-07-12T10:00:00.000Z', { amount_minor: 400000, category: 'Utilities' }),
];
const moved = categoryDelta(withPrior, august, july);
check('the biggest mover leads, by amount not percentage', moved[0].category, 'Utilities');
check('with both sides shown',
  [moved[0].wasMinor, moved[0].nowMinor, moved[0].changeMinor], [400000, 870000, 470000]);
check('a category that did not move is not listed',
  moved.some((d) => d.changeMinor === 0), false);
check('a category with no prior month has no percentage',
  categoryDelta(withPrior, august, null)[0].changePct, null);
// The imported July row is 900,000 of Groceries. Letting it into the comparison
// would report an 800,000 collapse that never happened.
check('imported history never feeds a comparison',
  categoryDelta(withPrior, august, july).some((d) => d.category === 'Groceries' && d.wasMinor > 0),
  false);

check('a target needs two complete months before it will guess',
  suggestedTarget(series, { now: new Date('2026-08-22T12:00:00.000Z') }), null);

console.log('\n--- chart geometry stays inside the frame ---');

/* The failure mode of a hand-rolled chart is geometric, not arithmetic: a bar
 * escaping the plot, a negative height, an axis that stops below the tallest
 * value. Checked here across the shapes the drill-down actually produces. */
const bucketsOf = (...pairs) =>
  pairs.map(([s, v], i) => ({ key: `k${i}`, label: `k${i}`, spendMinor: s, savedMinor: v }));

for (const [name, set] of [
  ['one bar', bucketsOf([100000, 0])],
  ['twelve months', bucketsOf(...Array.from({ length: 12 }, (_, i) => [100000 * (i + 1), 50000]))],
  ['a week of days', bucketsOf(...Array.from({ length: 7 }, () => [30000, 0]))],
  ['all zero', bucketsOf([0, 0], [0, 0])],
  ['a lump savings deposit', bucketsOf([10000, 5000000])],
]) {
  const { max, base, bars } = barLayout(set);
  const tallest = Math.max(...set.map((b) => b.spendMinor));
  const inside = bars.every(
    (m) =>
      m.x >= FRAME.left - 1 &&
      m.x + m.w <= FRAME.w - FRAME.right + 1 &&
      m.y >= FRAME.top - 0.01 &&
      m.h >= 0 &&
      m.y + m.h <= base + 0.01
  );
  check(`${name}: every mark inside the frame`, inside, true);
  check(`${name}: the axis reaches the tallest bar`, max >= tallest, true);
  check(`${name}: bars never wider than the cap`, bars.every((m) => m.w <= 24), true);
  check(`${name}: bars never touch`, bars.every((m, i) =>
    i === 0 || m.x >= bars[i - 1].x + bars[i - 1].w), true);
}

/* A single 50,000 deposit against a few thousand of daily spending used to set
 * the y-scale and squash every spending bar flat. The chart plots one series. */
const lump = barLayout(bucketsOf([10000, 5000000]));
check('a savings lump no longer sets the scale', lump.max, 10000);
check('so the spending bar fills the plot', Math.round(lump.bars[0].h), lump.plotH);

check('a nice ceiling rounds up, not down', [ceilNice(1), ceilNice(1170000), ceilNice(0)],
  [1, 1250000, 100]);
// Fine steps, so the tallest bar fills most of the frame rather than 60% of it.
check('and lands close above the value',
  [12014200, 5600, 99000].map((v) => ceilNice(v) / v).every((r) => r < 1.35), true);
check('axis labels stay short', [shortMinor(1200000), shortMinor(45000), shortMinor(150000000)],
  ['12k', '450', '1500k']);
check('the baseline is the zero line', gridLines(100000)[0].y, barLayout(bucketsOf([1, 1])).base);

console.log('\n--- waterfall, diverging bars, sparklines, pace ---');

/* A waterfall is only honest if every floating bar begins exactly where the
 * last one ended and the final bar equals the running total. */
const wf = bridgeLayout({
  startMinor: 1000000,
  steps: [{ label: 'Bills', minor: -200000 }, { label: 'Save', minor: -100000 }, { label: 'Owe', minor: -50000 }],
});
check('a waterfall has a bar per step plus two totals', wf.bars.length, 5);
check('and its final total is the running sum', wf.endMinor, 650000);
check('the closing bar carries that total', wf.bars.at(-1).valueMinor, 650000);
check('each floating step begins where the last ended',
  wf.bars.slice(1, -1).every((b, i) => b.fromMinor === wf.levels[i]), true);
const wfNeg = bridgeLayout({ startMinor: 100000, steps: [{ label: 'Owe', minor: -160000 }] });
check('a period over budget drops the scale below zero', wfNeg.min < 0, true);
check('and its closing total is negative', wfNeg.endMinor, -60000);

/* Diverging: the sign is the side. Positive starts at the centre and runs
 * right; negative ends at the centre and runs left; the scale is symmetric. */
const dv = divergingLayout(
  [{ minor: 4000 }, { minor: -2000 }, { minor: 0 }],
  { width: 300, labelW: 80, padRight: 20, rowH: 20, gap: 4 }
);
check('a positive diverging bar starts at the centre', Math.round(dv.rows[0].x), Math.round(dv.cx));
check('a negative one ends at the centre',
  Math.round(dv.rows[1].x + dv.rows[1].w), Math.round(dv.cx));
check('twice the magnitude is twice the bar', dv.rows[0].w, dv.rows[1].w * 2);
check('a zero balance draws no bar', dv.rows[2].w, 0);

/* A sparkline baselines at zero, so a steady run is not amplified into drama. */
const spk = sparkPoints([0, 100, 200], { w: 20, h: 10, pad: 0 });
check('a sparkline has a point per value', spk.length, 3);
check('its zero sits on the floor', spk[0].y, 10);
check('its peak sits on the ceiling', spk[2].y, 0);

/* Two lines on one day-based x-axis, so actual and ideal are comparable. */
const lp = linePoints([0, 500, 900], { slots: 5, maxMinor: 1000 });
check('a line spans its slots, not its samples', Math.round(lp.x(4)), FRAME.w - FRAME.right);
check('and maps value to height on a shared scale', Math.round(lp.y(1000)), FRAME.top);

/* The burn-down cumulates only real spend, and reads ahead/behind an even pace. */
const paceRows = [
  spend({ raw_name: 'chicken', amount_minor: 100000, category: 'Groceries', occurred_at: '2026-08-03T10:00:00.000Z' }),
  spend({ raw_name: 'Investment', amount_minor: 5000000, category: 'Savings', occurred_at: '2026-08-04T10:00:00.000Z' }),
  spend({ raw_name: 'lunch', amount_minor: 40000, category: 'Eating Out', occurred_at: '2026-08-06T10:00:00.000Z' }),
];
const pace = spendPace(paceRows, {
  start: '2026-08-03T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z',
  now: asOfAug8, budgetMinor: 2900000,
});
check('the burn-down cumulates spend only, not savings', pace.spentMinor, 140000);
check('its cumulative ends at the total spent', pace.cumulative.at(-1), 140000);
check('and it reports being well under an even pace', pace.overMinor < 0, true);

console.log('\n--- a reconciliation touches no time series ---');
const reconMonth = monthlySeries([
  spend({ raw_name: 'chicken', amount_minor: 100000, category: 'Groceries', occurred_at: '2026-08-05T10:00:00.000Z' }),
  spend({ raw_name: 'Reconcile cash', amount_minor: 5000, category: RECONCILE, occurred_at: '2026-08-06T10:00:00.000Z' }),
  spend({ raw_name: 'Reconcile cash', direction: 'in', amount_minor: 8000, category: RECONCILE, occurred_at: '2026-08-07T10:00:00.000Z' }),
]);
check('a reconciliation charge is not spend in the monthly series', reconMonth[0].spendMinor, 100000);
check('and a reconciliation credit is not income', reconMonth[0].incomeMinor, 0);
check('isSpend excludes a reconciliation row',
  isSpend({ direction: 'out', category: RECONCILE }), false);

/* One category's line across the months, keyed like categoryDelta. */
const csMonths = monthlySeries([
  spend({ raw_name: 'a', amount_minor: 1000, category: 'Groceries', occurred_at: '2026-07-10T10:00:00.000Z' }),
  spend({ raw_name: 'b', amount_minor: 3000, category: 'Groceries', occurred_at: '2026-08-10T10:00:00.000Z' }),
  spend({ raw_name: 'c', amount_minor: 9000, category: 'Eating Out', occurred_at: '2026-08-11T10:00:00.000Z' }),
]);
check('a category series lines up one value per month',
  categorySeries(
    [
      spend({ raw_name: 'a', amount_minor: 1000, category: 'Groceries', occurred_at: '2026-07-10T10:00:00.000Z' }),
      spend({ raw_name: 'b', amount_minor: 3000, category: 'Groceries', occurred_at: '2026-08-10T10:00:00.000Z' }),
    ],
    'Groceries', csMonths
  ), [1000, 3000]);

console.log('\n--- display names ---');
check('a tidy name replaces the raw text',
  txnLabel({ raw_name: 'home office indrive', display_name: 'Indrive Home → Office' }),
  'Indrive Home → Office');
check('a ride is tidied offline, before any model has run',
  txnLabel({ raw_name: 'Indrive gym-home' }), 'Indrive Gym → Home');
check('anything else falls back to what was typed',
  txnLabel({ raw_name: 'Eggs + Bread' }), 'Eggs + Bread');
check('the original is offered only when it differs',
  [hasRewrite({ raw_name: 'Eggs + Bread' }), hasRewrite({ raw_name: 'Indrive gym-home' })],
  [false, true]);

// Under a person's own heading, repeating their name on every line is what
// makes the panel unshareable.
const under = (raw, party) => ledgerLabel({ raw_name: raw, counterparty_name: party });
check('"for <person>" is dropped', under('Milk for Sister', 'Sister'), 'Milk');
check('so is "from"', under('chicken from sister', 'Sister'), 'chicken');
check('so is "to"', under('Loan to Sister', 'Sister'), 'Loan');
check('and the bracketed form', under('Internet Bundle(Uzair)', 'Uzair'), 'Internet Bundle');
check('a short form still matches', under('Slanty(for sis)', 'Sister'), 'Slanty');
check('a reimbursement reads as itself', under('Reimbursement from sister', 'Sister'), 'Reimbursement');
check('someone else in the clause is left alone', under('Gift for Eid', 'Sister'), 'Gift for Eid');
check('a name that is only part of the item survives',
  under('Anser Farewell + Oil Spray Bottle', 'Anser'), 'Anser Farewell + Oil Spray Bottle');
check('an entry with nothing left over keeps its text', under('for sister', 'Sister'), 'for sister');
check('a row with no counterparty is untouched', under('Milk for Sister', null), 'Milk for Sister');

console.log('\n--- route normalisation ---');
check('hyphen, no spaces', parseRoute('Indrive Flat-Office'), {
  provider: 'indrive',
  from: 'Flat',
  to: 'Office',
});
check('hyphen with spaces', parseRoute('Indrive Flat - Office'), {
  provider: 'indrive',
  from: 'Flat',
  to: 'Office',
});
check(
  'the two spellings collapse',
  groupKey('Indrive Flat-Office') === groupKey('Indrive Flat - Office'),
  true
);
check(
  'the reverse route stays distinct',
  groupKey('Indrive Flat - Office') === groupKey('Indrive Office - Flat'),
  false
);
check('a different provider is a different group',
  groupKey('Yango Flat-Office') === groupKey('Indrive Flat-Office'), false);
check('non-ride names are untouched', groupKey('Diet Coke'), 'item:diet coke');
check('punctuation is stripped', groupKey("Anser's Home") === groupKey('Ansers Home'), true);
check('acronyms keep their case', displayName('Indrive Anser-NUST'), 'Indrive Anser → NUST');
check('display arrow', displayName('Indrive Gym - Home'), 'Indrive Gym → Home');
check('template round-trips through the parser',
  parseEntry(`${templateText('Indrive Gym - Home')} 310`).name, 'Indrive Gym - Home');

if (hasCsv) {
console.log('\n--- time-of-day suggestions (from the real export) ---');
const rows = inputs.map((i) => ({
  raw_name: i.raw_name,
  amount_minor: i.amount_minor,
  direction: i.direction,
  occurred_at: i.occurred_at,
}));

// Anchor "now" to the last day in the export so the recency boost behaves as
// it will in real use.
const at = (h) => {
  const d = new Date(summary.max);
  d.setHours(h, 0, 0, 0);
  return d;
};

const morning = rankSuggestions(rows, { now: at(9), limit: 5 });
const evening = rankSuggestions(rows, { now: at(21), limit: 5 });

const labels = (list) => list.map((s) => s.label);
console.log(`  09:00 ->`);
for (const s of morning) console.log(`          ${s.label.padEnd(30)} ${formatMinor(s.amountMinor)}`);
console.log(`  21:00 ->`);
for (const s of evening) console.log(`          ${s.label.padEnd(30)} ${formatMinor(s.amountMinor)}`);

check('morning surfaces the commute out',
  labels(morning).some((l) => /Home → Office|Flat → Office/.test(l)), true);
check('evening surfaces the gym return',
  labels(evening).some((l) => /Gym → Home|Gym → Flat/.test(l)), true);
check('the two times of day differ',
  JSON.stringify(labels(morning)) === JSON.stringify(labels(evening)), false);
check('every suggestion carries a median amount',
  [...morning, ...evening].every((s) => Number.isInteger(s.amountMinor) && s.amountMinor > 0), true);

console.log('\n--- insights (from the real export) ---');
const asOf = new Date(summary.max);

const surge = rideSurge(rows);
const prices = priceIndex(rows);
const subs = subscriptions(rows, { now: asOf });
const months = monthlyTotals(rows);

console.log('  busiest routes:');
for (const r of surge.slice(0, 4)) {
  console.log(
    `    ${r.label.padEnd(30)} n=${String(r.count).padStart(2)} median ${formatMinor(r.medianMinor).padStart(9)}` +
      `  range ${formatMinor(r.minMinor)}-${formatMinor(r.maxMinor)}  overpaid ${formatMinor(r.overpaidMinor)}`
  );
}

console.log('  sharpest price moves:');
for (const p of prices.slice(0, 4)) {
  console.log(
    `    ${p.label.padEnd(30)} n=${String(p.count).padStart(2)} ${formatMinor(p.earlyMinor)} -> ${formatMinor(p.lateMinor)}  ${p.changePct > 0 ? '+' : ''}${p.changePct}%`
  );
}

console.log('  subscriptions:');
for (const s of subs) {
  console.log(
    `    ${s.label.padEnd(30)} ${s.cadence.padEnd(12)} every ${String(s.everyDays).padStart(2)}d  now ${formatMinor(s.lastMinor).padStart(9)}` +
      `${s.priceChanged ? ` (ranged ${formatMinor(s.minMinor)}-${formatMinor(s.maxMinor)})` : ''}${s.lapsed ? '  LAPSED' : ''}`
  );
}

console.log('  monthly spend:');
for (const m of months) console.log(`    ${m.month}  ${formatMinor(m.totalMinor)}`);

check('surge finds the repeated routes', surge.length >= 5, true);
check('Home -> Office is among them',
  surge.some((r) => /Home → Office/.test(r.label)), true);
check('every route reports a sane range',
  surge.every((r) => r.minMinor <= r.medianMinor && r.medianMinor <= r.maxMinor), true);
check('price index finds staples',
  prices.some((p) => /Chicken|Eggs|Yogurt/i.test(p.label)), true);
// Spotify actually bills every 15 days in this data, despite being named
// "Monthly subscription" — the detector has to classify by observed gaps, not
// by the word in the name.
check('Spotify detected', subs.some((s) => /Spotify/i.test(s.label)), true);
check('Spotify classed as fortnightly',
  subs.find((s) => /Spotify/i.test(s.label))?.cadence, 'fortnightly');
check('Spotify price drift flagged',
  subs.find((s) => /Spotify/i.test(s.label))?.priceChanged, true);
check('Netflix detected on two equal charges',
  subs.find((s) => /Netflix/i.test(s.label))?.cadence, 'monthly');
check('Claude Pro detected on two near-equal charges',
  subs.some((s) => /Claude Pro/i.test(s.label)), true);
check('irregular remittances are not called subscriptions',
  subs.some((s) => /Home Remittance/i.test(s.label)), false);
check('every subscription has a next due date',
  subs.every((s) => !Number.isNaN(Date.parse(s.nextDue))), true);
check('monthly totals reconcile with the file total',
  months.reduce((a, m) => a + m.totalMinor, 0), summary.spentMinor);

console.log('\n--- surge check on a single entry ---');
const homeOffice = surge.find((r) => /Home → Office/.test(r.label));
check('a normal fare is not flagged',
  surgeCheck(rows, 'Indrive Home - Office', homeOffice.medianMinor), null);
check('a fare 2x the median is flagged',
  surgeCheck(rows, 'Indrive Home - Office', homeOffice.medianMinor * 2) !== null, true);
check('a non-ride is never flagged', surgeCheck(rows, 'Chicken', 500000), null);
} else {
  console.log(
    '\n--- skipped: TransactionsLatest.csv not present ---\n' +
      '  The import, prediction and insight checks need the real export, which is\n' +
      '  personal data and stays out of the repo. Pure-logic checks above still ran.'
  );
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll checks passed.');
process.exit(fails ? 1 : 0);
