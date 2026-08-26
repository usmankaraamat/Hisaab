/* The category vocabulary, mirrored from the enrichment prompt so the client can
 * offer the same set for budgets and rules without importing server code. Kept
 * in sync by hand — the list changes about once a year. */
export const CATEGORIES = [
  'Rides',
  'Groceries',
  'Eating Out',
  'Drinks',
  'Subscriptions',
  'Entertainment',
  'Health',
  'Utilities',
  'Rent',
  'Fuel',
  'Education',
  'Shopping',
  'Gifts & Treats',
  'Charity',
  'Travel',
  'Savings',
  'Transfers & Loans',
  'Reimbursement',
  'Income',
  'Other',
];

/* Categories a spending budget makes sense for: consumption only. Savings, a
 * transfer, income and a reimbursement are money moving, not money spent, and a
 * cap on them would mean nothing. */
const NOT_SPEND = new Set(['Savings', 'Transfers & Loans', 'Income', 'Reimbursement']);

export const SPEND_CATEGORIES = CATEGORIES.filter((c) => !NOT_SPEND.has(c));
