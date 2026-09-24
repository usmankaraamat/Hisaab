/* Focused monetary checks for the two-pot account ledger. */
import { fundingSummary, fundingSource, overdrawnPots } from '../src/lib/funding.js';
import { budgetSummary } from '../src/lib/budget.js';
import { makeFundingTransfer } from '../src/lib/transfers.js';
import { monthlySeries, savingsRate } from '../src/lib/trends.js';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`);
}

const snapshot = { essentialMinor: 100_000, otherMinor: 500_000, at: '2026-09-01T10:00:00.000Z' };
const now = new Date('2026-09-05T00:00:00.000Z');
const row = (overrides) => ({
  id: crypto.randomUUID(), amount_minor: 0, direction: 'out', source: 'manual',
  occurred_at: '2026-09-02T10:00:00.000Z', raw_name: 'thing', ...overrides,
});

check('legacy source defaults to essential', fundingSource({}), 'essential');
check('malformed snapshots are rejected rather than coerced into balances', [
  fundingSummary([], { essentialMinor: '100', otherMinor: 0, at: snapshot.at }, now),
  fundingSummary([], { essentialMinor: 100, otherMinor: null, at: snapshot.at }, now),
  fundingSummary([], { essentialMinor: 100, otherMinor: 0, at: null }, now),
], [null, null, null]);
check('two pots fold outgoing, incoming, and other source independently',
  fundingSummary([
    row({ amount_minor: 10_000 }),
    row({ amount_minor: 20_000, funding_source: 'other' }),
    row({ amount_minor: 3_000, direction: 'in', funding_source: 'other' }),
  ], snapshot, now),
  { at: snapshot.at, essentialMinor: 90_000, otherMinor: 483_000, totalMinor: 573_000 });

check('snapshot boundary is exclusive while now is inclusive',
  fundingSummary([
    row({ amount_minor: 10_000, occurred_at: snapshot.at }),
    row({ amount_minor: 20_000, occurred_at: now.toISOString() }),
  ], snapshot, now).essentialMinor,
  80_000);
check('deleted, imported, future and borrowed outgoing rows do not change cash',
  fundingSummary([
    row({ amount_minor: 10_000, deleted: 1 }),
    row({ amount_minor: 20_000, source: 'bluecoins' }),
    row({ amount_minor: 30_000, occurred_at: '2026-09-06T00:00:00.000Z' }),
    row({ amount_minor: 40_000, ledger_effect: 'borrowed' }),
  ], snapshot, now),
  { at: snapshot.at, essentialMinor: 100_000, otherMinor: 500_000, totalMinor: 600_000 });
check('edited source is reflected from the live row',
  fundingSummary([row({ amount_minor: 25_000, funding_source: 'other' })], snapshot, now),
  { at: snapshot.at, essentialMinor: 100_000, otherMinor: 475_000, totalMinor: 575_000 });
const toggleRow = row({ amount_minor: 25_000, funding_source: 'other' });
check('moving an expense between pots preserves total and restores essential',
  [
    fundingSummary([toggleRow], snapshot, now).totalMinor,
    fundingSummary([toggleRow], snapshot, now).essentialMinor,
    fundingSummary([{ ...toggleRow, funding_source: 'essential' }], snapshot, now).totalMinor,
    fundingSummary([{ ...toggleRow, funding_source: 'essential' }], snapshot, now).essentialMinor,
  ], [575_000, 100_000, 575_000, 75_000]);
check('deleting an other-funded expense restores that pot',
  fundingSummary([{ ...toggleRow, deleted: 1 }], snapshot, now),
  { at: snapshot.at, essentialMinor: 100_000, otherMinor: 500_000, totalMinor: 600_000 });
check('funding continues across calendar months',
  fundingSummary([row({ amount_minor: 11_000, occurred_at: '2026-10-03T10:00:00.000Z' })], snapshot, new Date('2026-10-04T00:00:00.000Z')).essentialMinor,
  89_000);
check('a cash loan arriving counts, while a borrowed purchase does not',
  fundingSummary([
    row({ amount_minor: 50_000, direction: 'in', ledger_effect: 'borrowed' }),
    row({ amount_minor: 15_000, direction: 'out', ledger_effect: 'borrowed' }),
  ], snapshot, now),
  { at: snapshot.at, essentialMinor: 150_000, otherMinor: 500_000, totalMinor: 650_000 });

const topUp = makeFundingTransfer({ from: 'other', amountMinor: 12_345, occurredAt: '2026-09-02T10:00:00.000Z' });
const topUpBalances = fundingSummary([topUp], snapshot, now);
check('a top-up moves exact cents from Other to Essential without changing total',
  [topUpBalances.essentialMinor, topUpBalances.otherMinor, topUpBalances.totalMinor],
  [112_345, 487_655, 600_000]);
const moveOut = makeFundingTransfer({ from: 'essential', amountMinor: 50_001, occurredAt: '2026-09-02T10:00:00.000Z' });
const moveOutBalances = fundingSummary([moveOut], snapshot, now);
check('an Essential-to-Other move preserves total in the other direction',
  [moveOutBalances.essentialMinor, moveOutBalances.otherMinor, moveOutBalances.totalMinor],
  [49_999, 550_001, 600_000]);
check('deleting one transfer restores both balances atomically',
  fundingSummary([{ ...topUp, deleted: 1 }], snapshot, now),
  { at: snapshot.at, essentialMinor: 100_000, otherMinor: 500_000, totalMinor: 600_000 });
const transferReport = budgetSummary([topUp], { funding: snapshot, now });
check('a balance transfer is neither monthly income nor spending',
  [transferReport.incomeMinor, transferReport.spendMinor, transferReport.outMinor, transferReport.transferMinor, transferReport.cashMinor],
  [0, 0, 0, 0, 600_000]);
const legacyTransferReport = budgetSummary([topUp], { now });
check('a transfer cannot reduce a legacy one-pot cash report',
  [legacyTransferReport.incomeMinor, legacyTransferReport.outMinor, legacyTransferReport.transferMinor, legacyTransferReport.cashMinor],
  [0, 0, 0, 0]);
const savingsRows = [
  row({ direction: 'in', amount_minor: 100_000, category: 'Income' }),
  row({ direction: 'out', amount_minor: 25_000, category: 'Savings' }),
];
const beforeTransferSeries = monthlySeries(savingsRows);
const afterTransferSeries = monthlySeries([...savingsRows, topUp]);
check('a transfer leaves monthly income, savings, and savings rate unchanged',
  [
    afterTransferSeries[0].incomeMinor,
    afterTransferSeries[0].savedMinor,
    savingsRate(afterTransferSeries[0]),
  ],
  [beforeTransferSeries[0].incomeMinor, beforeTransferSeries[0].savedMinor, savingsRate(beforeTransferSeries[0])]);

const fundedBudget = budgetSummary([
  row({ amount_minor: 25_000, funding_source: 'other', category: 'Entertainment' }),
  row({ amount_minor: 10_000, funding_source: 'essential', category: 'Groceries' }),
], { funding: snapshot, now });
check('budget cash shows both pots while allowance follows essential',
  [fundedBudget.cashMinor, fundedBudget.essentialMinor, fundedBudget.otherMinor, fundedBudget.safeToSpendMinor],
  [565_000, 90_000, 475_000, 90_000]);
check('funding snapshot anchors an otherwise empty budget',
  budgetSummary([], { funding: snapshot, now }).anchoredTo, 'funding');
const reportingWindow = budgetSummary([
  row({ amount_minor: 10_000, category: 'Groceries', occurred_at: '2026-09-02T10:00:00.000Z' }),
  row({ amount_minor: 20_000, category: 'Savings', occurred_at: '2026-09-03T10:00:00.000Z' }),
], {
  funding: { essentialMinor: 70_000, otherMinor: 500_000, at: '2026-09-10T10:00:00.000Z' },
  // A legacy one-pot balance must not cut off this month's reporting either.
  opening: { amountMinor: 90_000, at: '2026-09-10T10:00:00.000Z' },
  now: new Date('2026-09-15T12:00:00.000Z'),
});
check('a funding snapshot keeps earlier monthly spending and savings in the reporting window',
  [reportingWindow.anchoredTo, reportingWindow.since === reportingWindow.periodStart, reportingWindow.spendMinor, reportingWindow.savedMinor],
  ['funding', true, 10_000, 20_000]);

const recurringNow = new Date('2026-08-15T12:00:00.000Z');
const recurringFunding = { essentialMinor: 100_000, otherMinor: 500_000, at: '2026-08-02T00:00:00.000Z' };
const cardBillRows = [
  row({ raw_name: 'Netflix', amount_minor: 10_000, funding_source: 'other', occurred_at: '2026-07-02T10:00:00.000Z' }),
  row({ raw_name: 'Netflix', amount_minor: 10_000, funding_source: 'other', occurred_at: '2026-08-01T10:00:00.000Z' }),
];
const cardBillBudget = budgetSummary(cardBillRows, { funding: recurringFunding, now: recurringNow });
check('a recurring card bill does not reduce essential safe-to-spend or daily allowance',
  [cardBillBudget.committedMinor, cardBillBudget.totalCommittedMinor, cardBillBudget.safeToSpendMinor, cardBillBudget.dailyMinor],
  [0, 10_000, 100_000, 5_800]);


const pots = (e, o) => ({ essentialMinor: e, otherMinor: o });
check('a save that takes a pot below zero is reported',
  overdrawnPots(pots(100, 352_400), pots(100, -147_600)), [{ label: 'Other bank', minor: -147_600 }]);
check('a pot already below zero is reported again only when it drops further',
  [overdrawnPots(pots(-500, 0), pots(-500, 0)).length, overdrawnPots(pots(-500, 0), pots(-900, 0)).length], [0, 1]);
check('money coming into an overdrawn pot is not a warning',
  overdrawnPots(pots(-900, 0), pots(-400, 0)), []);

if (failures) process.exitCode = 1;
