/* The enrichment contract: categories, output schema, system prompt.
 *
 * Plain ESM on purpose. Deno imports it from index.ts and Node imports it from
 * scripts/eval/run.mjs, so the benchmark grades the prompt that actually ships
 * rather than a copy that drifts.
 */

export const CATEGORIES = [
  'Rides',
  'Groceries',
  'Eating Out',
  'Drinks',
  'Subscriptions',
  'Health',
  'Utilities',
  'Rent',
  'Shopping',
  'Gifts & Treats',
  'Travel',
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
          'canonical_item',
          'route',
          'counterparty',
          'ledger_effect',
          'confidence',
        ],
        properties: {
          id: { type: 'string', description: 'The transaction id, copied exactly.' },
          category: { type: 'string', enum: CATEGORIES },
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

2. Ride entries begin with a provider (Indrive, Yango, Careem, Uber, Bykea) followed by a route. Direction matters: "Flat - Office" and "Office - Flat" are different routes, not the same one. Normalise place names to the spelling and casing already used in the canonical route list, and fix obvious typos to match it ("Flat-Offic" is "Flat -> Office"). Category is always "Rides". Place names often contain digits — "F10", "26 Number", "H-13", "I8", "Trail 5" are sector and stop names in Islamabad, not amounts.

3. A word can be a person in one entry and a place in another. In "Anser Farewell" it is a person; in "Indrive Anser-NUST" it is a place on a route. Decide from the surrounding text, not from the word alone. Never set a counterparty from a place name inside a route.

4. Set counterparty and ledger_effect only when money actually moved between the user and a named person as a debt:
   - "Loan to Mirza"                -> counterparty Mirza,      ledger_effect "lent"
   - "Loan from Khuzaima"           -> counterparty Khuzaima,   ledger_effect "borrowed"
   - "Loan Return from Sister"      -> counterparty Sister,     ledger_effect "repaid_by"
   - "Loan return to Khuzaima"      -> counterparty Khuzaima,   ledger_effect "repaid_to"
   When the text names a loan but not its direction ("Mirza Loan"), use the direction field: money out is "lent", money in is "borrowed" — and lower the confidence, because a repayment looks identical.
   Buying something *for* someone ("Pizza for sister", "Internet Bundle(Uzair)") is a gift, not a debt: set counterparty, leave ledger_effect null.

5. Reimbursements received are incoming money with category "Reimbursement". Use ledger_effect "repaid_by" only when the text says the user had previously paid on someone's behalf; otherwise leave it null.

6. A recurring bill for a utility (electricity, gas, water, internet) is "Utilities", not "Subscriptions". "Subscriptions" is for software and media services.

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
