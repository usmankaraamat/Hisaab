/* Graded benchmark for the enrichment pass.
 *
 * Every case below is a real entry from TransactionsLatest.csv, chosen because
 * it is hard in a specific way: route direction, a word that is a person in one
 * entry and a place in another, a gift that looks like a loan, a typo, or a
 * name so terse that the honest answer is low confidence.
 *
 * Fields set to 'any' are not graded — some entries genuinely admit more than
 * one reading and scoring them would measure agreement with me, not accuracy.
 */

// Seeded canonical state, so the run tests reuse-verbatim under production
// conditions rather than a cold start.
export const KNOWN = {
  items: [
    'Diet Soda',
    'Ice Cream',
    'Chicken',
    'Yogurt',
    'Eggs',
    'Chai',
    'Spotify Subscription',
    'Padel',
    'Toothpaste',
  ],
  routes: [
    'indrive: Flat -> Office',
    'indrive: Office -> Flat',
    'indrive: Home -> Office',
    'indrive: Gym -> Home',
    'indrive: Gym -> Flat',
    'yango: Flat -> Office',
  ],
  people: [
    'Khuzaima',
    'Mirza',
    'Sister',
    'Abdurrehman',
    'Anser',
    'Uzair',
    'Talha',
    'Mutahhar Bhai',
    'Hashaam',
  ],
};

const ride = (provider, from, to) => ({ provider, from, to });

export const CASES = [
  // ---- route direction: the same two places, opposite ways ----
  { name: 'Indrive Flat-Office', cat: ['Rides'], route: ride('indrive', 'Flat', 'Office') },
  { name: 'Indrive Flat - Office', cat: ['Rides'], route: ride('indrive', 'Flat', 'Office') },
  { name: 'Indrive Office - Flat', cat: ['Rides'], route: ride('indrive', 'Office', 'Flat') },
  { name: 'Indrive gym-flat', cat: ['Rides'], route: ride('indrive', 'Gym', 'Flat') },

  // ---- typos and casing must still hit the canonical route ----
  { name: 'Yango Flat-Offic', cat: ['Rides'], route: ride('yango', 'Flat', 'Office') },
  { name: 'indrive bus stop- flat', cat: ['Rides'], route: ride('indrive', 'Bus Stop', 'Flat') },

  // ---- digits inside place names, not amounts ----
  { name: 'Indrive F10-26 Number', cat: ['Rides'], route: ride('indrive', 'F10', '26 Number') },
  { name: 'Indrive H-13-26 Number', cat: ['Rides'], route: ride('indrive', 'H-13', '26 Number') },
  { name: 'Indrive NUST-I8', cat: ['Rides'], route: ride('indrive', 'NUST', 'I8') },

  // ---- "Anser": a place here ... ----
  { name: 'Indrive Anser-NUST', cat: ['Rides'], route: ride('indrive', 'Anser', 'NUST'), party: null },
  { name: 'Indrive H13-Anser', cat: ['Rides'], route: ride('indrive', 'H13', 'Anser'), party: null },
  { name: 'Indrive Anser-Trail 5', cat: ['Rides'], route: ride('indrive', 'Anser', 'Trail 5'), party: null },

  // ---- ... and a person here ----
  { name: 'Anser Farewell + Oil Spray Bottle', cat: 'any', route: null, party: 'Anser' },
  { name: "Anser's Bus Ticket", cat: 'any', route: null, party: 'Anser' },

  // ---- the debt ledger ----
  { name: 'Loan to Mirza', cat: ['Transfers & Loans'], ledger: 'lent', party: 'Mirza', route: null },
  { name: 'Loan to Talha', cat: ['Transfers & Loans'], ledger: 'lent', party: 'Talha', route: null },
  { name: 'Loan to sister', cat: ['Transfers & Loans'], ledger: 'lent', party: 'Sister', route: null },
  { name: 'Loan to Abdurrehman', cat: ['Transfers & Loans'], ledger: 'lent', party: 'Abdurrehman', route: null },
  { name: 'Loan from Khuzaima', cat: ['Transfers & Loans'], ledger: 'borrowed', party: 'Khuzaima', route: null, dir: 'in' },
  { name: 'Loan return to Khuzaima', cat: ['Transfers & Loans'], ledger: 'repaid_to', party: 'Khuzaima', route: null },
  { name: 'Loan Return from Sister', cat: ['Transfers & Loans'], ledger: 'repaid_by', party: 'Sister', route: null, dir: 'in' },
  { name: 'Loan Return from Abdurrehman', cat: ['Transfers & Loans'], ledger: 'repaid_by', party: 'Abdurrehman', route: null, dir: 'in' },

  // ---- loans whose direction is only recoverable from the amount sign ----
  { name: 'Mirza Loan', cat: ['Transfers & Loans'], party: 'Mirza', ledger: 'any', route: null, ambiguous: true },
  { name: 'Abdurrehman Loan', cat: ['Transfers & Loans'], party: 'Abdurrehman', ledger: 'any', route: null, ambiguous: true },
  { name: "Anser's Loan", cat: ['Transfers & Loans'], party: 'Anser', ledger: 'any', route: null, ambiguous: true },

  // ---- bought FOR someone: a gift, not a loan ----
  { name: 'Pizza for sister', cat: 'any', ledger: null, party: 'Sister', route: null },
  { name: 'Treat for sister', cat: 'any', ledger: null, party: 'Sister', route: null },
  { name: 'DSM-5 Book for sis', cat: 'any', ledger: null, party: 'Sister', route: null },
  { name: 'Slanty(for sis)', cat: 'any', ledger: null, party: 'Sister', route: null },
  { name: 'Internet Bundle(Uzair)', cat: 'any', ledger: null, party: 'Uzair', route: null },

  // ---- reimbursements ----
  { name: 'Reimbursement from Mutahhar Bhai', cat: ['Reimbursement'], party: 'Mutahhar Bhai', route: null, dir: 'in' },
  { name: 'Security Reimbursement', cat: ['Reimbursement'], party: null, route: null, dir: 'in' },
  { name: 'KFC + Indrive + Padel Reimbursement', cat: ['Reimbursement'], route: null, dir: 'in' },

  // ---- subscriptions ----
  { name: 'Spotify Monthly subscription', cat: ['Subscriptions'], route: null, ledger: null },
  { name: 'Spotify', cat: ['Subscriptions'], route: null, ledger: null },
  { name: 'Monthly Netflix Subscription', cat: ['Subscriptions'], route: null, ledger: null },
  { name: 'Claude Pro Subscription', cat: ['Subscriptions'], route: null, ledger: null },
  { name: 'Capcut Subscription', cat: ['Subscriptions'], route: null, ledger: null },

  // ---- utilities vs subscriptions: a recurring bill is not a subscription ----
  { name: 'Electricity Bill', cat: ['Utilities'], route: null },
  { name: 'Internet Bill', cat: ['Utilities'], route: null },
  { name: 'StormFiber Package', cat: ['Utilities'], route: null },
  { name: 'LP Gas Refill', cat: ['Utilities', 'Shopping'], route: null },

  // ---- the sodas and ice creams that must collapse ----
  { name: 'Diet Coke', cat: ['Drinks'], route: null },
  { name: 'Diet Pepsi', cat: ['Drinks'], route: null },
  { name: 'Cold Drink', cat: ['Drinks'], route: null },
  { name: 'Colddrink', cat: ['Drinks'], route: null },
  { name: 'Coke Zero', cat: ['Drinks'], route: null },
  { name: 'Ice Creams', cat: 'any', route: null },
  { name: 'Ice cream', cat: 'any', route: null },
  { name: 'Toothpaste + Tooth brush', cat: 'any', route: null },

  // ---- health, not groceries ----
  { name: 'Finasteride', cat: ['Health'], route: null },
  { name: 'Minoxidil', cat: ['Health'], route: null },
  { name: 'Vitamin D3 and K2 tablets', cat: ['Health'], route: null },
  { name: 'Panadol', cat: ['Health'], route: null },

  // ---- income ----
  { name: 'Salary', cat: ['Income'], route: null, ledger: null, dir: 'in' },
  { name: 'Paycheck', cat: ['Income'], route: null, ledger: null, dir: 'in' },
  // Money sent home, not received — outgoing, and not a debt.
  { name: 'Home Remittance', cat: 'any', route: null, ledger: null, dir: 'out' },

  // ---- transport without a ride-hailing provider ----
  { name: 'Freight Flat - Home', cat: 'any', ledger: null },
  { name: 'Hiace 26No. - Malakand Stop', cat: ['Rides', 'Travel'], ledger: null },
  { name: 'ISB-LHR ticket', cat: ['Travel'], ledger: null },

  // ---- terse enough that low confidence is the correct answer ----
  { name: 'Washroom', cat: 'any', ambiguous: true },
  { name: '200', cat: 'any', ambiguous: true },
  { name: 'Trashman', cat: 'any', ambiguous: true },
  { name: 'My Jeep', cat: 'any', ambiguous: true },
  { name: 'Unaccounted Balance', cat: 'any', ambiguous: true },
  { name: 'Adhoc Needed at home', cat: 'any', ambiguous: true },
];

/** Raw names that must end up sharing one canonical_item. */
export const COLLAPSE = [
  ['Diet Coke', 'Diet Pepsi', 'Cold Drink', 'Colddrink', 'Coke Zero'],
  ['Ice Creams', 'Ice cream'],
  ['Spotify Monthly subscription', 'Spotify'],
  ['Indrive Flat-Office', 'Indrive Flat - Office'],
];

/** Pairs that must NOT share a canonical item — collapsing these loses meaning. */
export const DISTINCT = [
  ['Indrive Flat-Office', 'Indrive Office - Flat'],
  // Not "Loan to Mirza" vs "Loan from Khuzaima": a shared canonical item of
  // "Loan" is correct there, because counterparty and ledger_effect already
  // carry the direction. Collapsing two different services does lose meaning.
  ['Spotify Monthly subscription', 'Monthly Netflix Subscription'],
  ['Electricity Bill', 'Internet Bill'],
  ['Indrive Anser-NUST', 'Anser Farewell + Oil Spray Bottle'],
];
