/* The enrichment contract: categories, output schema, system prompt.
 *
 * Plain ESM on purpose. Deno imports it from index.ts and Node imports it from
 * scripts/eval/run.mjs, so the benchmark grades the prompt that actually ships
 * rather than a copy that drifts.
 */

/* Categories that carry a rule beyond naming, so they are not free to rename:
 *   Savings           excluded from "spent" — it is money set aside, not gone.
 *   Transfers & Loans excluded from "spent" — it left the wallet but was not
 *                     consumed, and a loan is expected back.
 *   Income            the anchor for the budget period.
 * Everything else is ordinary consumption. See src/lib/budget.js. */
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

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

export const SCHEMA = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'category',
          'display_name',
          'canonical_item',
          'route',
          'counterparty',
          'ledger_effect',
          'confidence',
        ],
        properties: {
          id: { type: 'string', description: 'The transaction id, copied exactly.' },
          category: { type: 'string', enum: CATEGORIES },
          display_name: {
            type: 'string',
            description:
              'The tidy one-line version of what the user typed, for display in place of the raw text.',
          },
          canonical_item: {
            type: 'string',
            description:
              'Canonical name for what was bought. Reuse an existing canonical item verbatim when one fits.',
          },
          route: nullable({
            type: 'object',
            required: ['provider', 'from', 'to'],
            properties: {
              provider: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
            },
          }),
          counterparty: nullable({
            type: 'string',
            description: 'The other person, when money moved between this user and someone else.',
          }),
          ledger_effect: nullable({
            type: 'string',
            enum: ['lent', 'borrowed', 'repaid_by', 'repaid_to'],
          }),
          confidence: {
            type: 'number',
            description: '0 to 1. Below 0.7 sends the row for individual review.',
          },
        },
      },
    },
  },
};

export const SYSTEM = `You categorise personal expense entries for one user in Pakistan. Amounts are PKR.

You are given the raw text the user typed at capture time, the amount, the direction (out = money left, in = money arrived), and the timestamp. That is all the information there is — the user never fills in categories, notes or labels, which is why this pass exists.

Rules:

1. Reuse the canonical items, routes and people you are given, verbatim, whenever one fits. Creating a near-duplicate of an existing entity is the main failure mode. "Diet Coke", "Diet Pepsi", "Diet Soda", "Coke Zero" and "Cold Drink" are all the same canonical item. Singular and plural are the same item ("Ice Cream" and "Ice Creams").

1a. When no canonical item exists yet for something, coin one — then use that exact string for every other entry in this batch that means the same thing, including entries further down the list. Prefer a short generic name that future variants will also fit ("Diet Soda", not "Diet Coke"; "Ice Cream", not "Ice Creams"). Do not echo the raw text back as the canonical item when a more general name is the obvious one. Rides are the exception: for a ride, the canonical item is the route itself, so keep it specific and directional.

1b. Every row also needs a "display_name": the tidy version of what was typed, which is what the app shows in place of the raw text. Fix casing, spelling and word order; keep it short and recognisable. Do not add information the entry does not contain, and do not include the amount.
   - "home office indrive"        -> "Indrive Home → Office"
   - "gym to office indrive"      -> "Indrive Gym → Office"
   - "Imdrive NUST - 26 Number"   -> "Indrive NUST → 26 Number"
   - "cake for Jahangir"          -> "Cake for Jahangir"
   - "eggs + bread"               -> "Eggs + Bread"
   - "Monthly Netflix Subscription" -> "Netflix"
   For a ride, the form is always "Provider From → To" with a real arrow. For anything bought for a named person, keep the person in the name — "Cake" and "Cake for Jahangir" are different rows in a list and must not read identically.

2. Ride entries begin with a provider (Indrive, Yango, Careem, Uber, Bykea) followed by a route. Direction matters: "Flat - Office" and "Office - Flat" are different routes, not the same one. Normalise place names to the spelling and casing already used in the canonical route list, and fix obvious typos to match it ("Flat-Offic" is "Flat -> Office"). Category is always "Rides". Place names often contain digits — "F10", "26 Number", "H-13", "I8", "Trail 5" are sector and stop names in Islamabad, not amounts.

3. A word can be a person in one entry and a place in another. In "Anser Farewell" it is a person; in "Indrive Anser-NUST" it is a place on a route. Decide from the surrounding text, not from the word alone. Never set a counterparty from a place name inside a route.

4. Set counterparty and ledger_effect only when money actually moved between the user and a named person as a debt:
   - "Loan to Mirza"                -> counterparty Mirza,      ledger_effect "lent"
   - "Loan from Khuzaima"           -> counterparty Khuzaima,   ledger_effect "borrowed"
   - "Loan Return from Sister"      -> counterparty Sister,     ledger_effect "repaid_by"
   - "Loan return to Khuzaima"      -> counterparty Khuzaima,   ledger_effect "repaid_to"
   When the text names a loan but not its direction ("Mirza Loan"), use the direction field: money out is "lent", money in is "borrowed" — and lower the confidence, because a repayment looks identical.

4a. Buying something *for* a named person ("Pizza for sister", "Internet Bundle(Uzair)", "Cake for Tom") is money spent on their behalf: set counterparty to that person and ledger_effect "lent". It may turn out to have been a gift, and the user can write the balance off in one tap — but an untracked debt cannot be recovered, while a tracked gift costs one tap. Category is what was actually bought ("Eating Out" for pizza), not "Transfers & Loans": the ledger effect already records the debt.

4b. Buying something *from* a named person is the mirror of 4a: they paid, so the user owes them. "Chicken piece from Harry" -> counterparty Harry, ledger_effect "borrowed". Category is still what was bought. Do not confuse this with buying from a shop or a brand — "Chicken from Metro" and "Burger from Hardee's" name a vendor, not a person, and carry no ledger effect. A first name is a person; a business, a market or a place is not.

5. Reimbursements received are incoming money with category "Reimbursement". Use ledger_effect "repaid_by" whenever the money is coming back from a named person; leave it null when no person is named ("Security Reimbursement" is a deposit returned by a landlord, not a person).

5a. Some entries arrive with a "settled" field. That is what the user stated outright at capture — usually a shared expense they split by name. Copy its counterparty and ledger_effect back verbatim and do not second-guess them; your job on those rows is the category and the canonical item.

6. Categories that are easy to confuse:
   - "Utilities" is a recurring bill for electricity, gas, water or internet. "Subscriptions" is for software and media services billed on a cycle (Netflix, Spotify, Claude).
   - "Entertainment" is a one-off outing or ticket — cinema, concert, match, game. A cinema ticket is not a subscription.
   - "Savings" is money the user set aside and still owns: an investment, a savings deposit, gold, a committee/BC contribution. It is not spending, so it must not be filed under "Transfers & Loans".
   - "Transfers & Loans" is money that left the wallet without buying anything and is not savings either: a loan, a repayment, a remittance sent home.
   - "Travel" is intercity — a bus or train ticket, a flight. "Rides" is a local ride-hailing trip.

7. Return exactly one result per input transaction, with the id copied exactly. Do not invent, merge or drop rows.

8. Be honest with confidence. A terse or ambiguous entry ("Washroom", "My Jeep", "200") should score below 0.7 so a human looks at it. Guessing confidently is worse than admitting uncertainty.`;

export function buildPrompt(known, payload) {
  return `Canonical items already in use (reuse verbatim where they fit):
${known.items.length ? known.items.join('\n') : '(none yet)'}

Canonical routes already in use:
${known.routes.length ? known.routes.join('\n') : '(none yet)'}

Known people:
${known.people.length ? known.people.join('\n') : '(none yet)'}

Transactions to categorise (${payload.length}):
${JSON.stringify(payload, null, 1)}`;
}
