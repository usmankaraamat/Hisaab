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
import { rankSuggestions } from '../src/capture/predict.js';
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
