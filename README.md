# Hisaab

A personal expense tracker built around one idea: **capture and enrichment are
separate jobs, and forcing them into the same moment is why expense apps fail.**

Typing an expense takes under three seconds and works with no network. Deciding
what it *was* — the category, the route, whether it was a loan and to whom —
happens later, in a batch, and is done by a model rather than by hand.

## Why

Three months of real data from the app this replaces: 397 transactions across 91
of 92 days. Capture habit: essentially perfect. Every single one of those rows is
categorised `Others`, in account `Wallet`, with no note and no label. The capture
UI was fast enough to use daily; the enrichment UI was never used once.

So capture never blocks on a decision, and enrichment never blocks capture.

## How it works

```
Browser (PWA, GitHub Pages)
  ├── IndexedDB ......... source of truth for capture; append-only event log
  ├── Service worker .... offline shell; entry NEVER touches the network
  └── Sync .............. push/pull to Supabase when online, last-write-wins
                              │
Supabase
  ├── Postgres .......... transactions, canonical items/routes/people, proposals
  ├── RLS ............... every policy scoped to auth.uid()
  └── Edge Function ..... `enrich` — holds the model API key server-side
                              │
                        Gemini (gemini-3.5-flash-lite)
```

Money is stored in integer minor units. `raw_name` — exactly what was typed — is
immutable; every model-derived field is nullable and versioned, so a bad pass can
be recomputed without touching the original text.

That immutability is why the tidy name is a separate column. `home office
indrive` resolves to **Indrive Home → Office**, and the app shows that, with the
raw text underneath whenever the two differ — so a rewrite is visible rather than
silent, and the evidence a re-run needs is still there.

**Nothing auto-commits.** The enrichment pass writes to `enrichment_proposals`
with status `pending`. The Review tab promotes them. A bad pass costs one tap.

## Capture

One line: `chicken 900`. The amount is taken only from a standalone first or last
token, because real entries contain digits that are not amounts — `Indrive F10-26
Number`, `26 Number - Anser's Home`. A leading `+` marks incoming money.

Suggestion chips are ranked by hour-of-day against your own history, so the top
chip is the morning commute at 09:00 and the gym ride home at 21:00. Ride entries
are ~30% of all entries, and this turns most of them into one tap.

## Shared expenses

Paying for other people is a debt, not a purchase, and one row cannot say that.
`cake for tom, dick, harry 2500` becomes three rows of 833.34/833.33/833.33 —
shares always add back to what was typed — each owed by one person. None of it is
charged to you unless you say `…, me`, in which case your share becomes an
ordinary expense and the rest stays owed.

`reimbursement from tom 500` is the other half: incoming money against Tom, which
the **Ledger** tab nets against his share.

It runs both ways. `chicken piece from harry 500` means Harry paid, so the debt
points the other direction — and because nothing left your wallet, that row
raises what you owe without reducing your cash. `loan from khuzaima 25000` is
the case where money really did arrive, so it does both.

This runs at capture, not in the enrichment pass, because it is not an inference
— you named the people. The ledger is therefore correct on a phone with no
signal, hours before any model runs. Enrichment still assigns the category, and
`accept_proposal` coalesces so it can never overwrite a counterparty or ledger
effect you stated yourself.

Two guards keep it from inventing people. A single *unfamiliar* name is offered
rather than applied — otherwise `charger for laptop` mints a person called
Laptop — so the first `cake for tom` costs one tap and every later entry naming
Tom splits on its own. And `+` is not a name separator, because real entries like
`Anser Farewell + Oil Spray Bottle` use it to join two things.

Not every "for someone" entry is really a debt. Rather than guess, the balance is
tracked and the ledger offers one tap to call it square — which leaves the spend
intact in history. An untracked debt is unrecoverable; a tracked gift costs a tap.
Entries are written off individually as well as per person, because buying
someone four things and meaning one of them as a gift is ordinary.

## What is left

The question that made tracking worth starting — *how much do I have?* — is not
one number. In three months of live data, 83,300 of 121,676 rupees "spent" was an
investment, a remittance and a loan. A balance that treats those as consumption
is wrong on day one, and a number caught lying once stops being read. So four are
computed:

| | |
| --- | --- |
| **cash** | everything that actually moved. The honest total. |
| **spend** | consumption only. Savings, transfers and money lent out are excluded. |
| **committed** | recurring charges already due before the next income. |
| **safe** | cash − committed − the savings target not yet met − what you owe. |

`safe ÷ days left` sits under the capture input, because that is the only place a
number can change a decision. The period runs from your last income entry, not
the calendar: a salary landing on the 3rd makes "this month" the wrong window and
every allowance computed from it wrong for three days.

The savings target is deducted **before** the allowance, not left over after it.
Saving what remains at the end of the month is exactly the thing that does not
work.

## Entering the same thing twice

`Cake 2200` was entered, and thirty-five minutes later the same cake was entered
again as a five-way split of 440. Nothing noticed; 2,200 was counted twice. It is
the natural failure of an app that makes logging take three seconds — re-entering
is cheaper than checking.

So capture warns when the same thing at the same amount is already there. A split
is compared at its **total**, because no single 440 share matches a 2,200 row.
A warning, never a block: buying two Diet Cokes in an afternoon is ordinary, and
the user is the one who knows.

## Model choice is measured, not assumed

`scripts/eval/` grades the enrichment prompt against 79 real entries chosen for
being hard: route direction (`Flat → Office` ≠ `Office → Flat`), a word that is a
person in one entry and a place in another (`Anser Farewell` vs `Indrive
Anser-NUST`), gifts that look like loans (`Pizza for sister`), a person and a
vendor one preposition apart (`Lunch from Khuzaima` vs `Burger from Hardees`),
typos (`Yango Flat-Offic`), and entries terse enough that low confidence is the
correct answer (`Washroom`).

| model | overall | routes | ledger | display | calibration | cost / 79 rows |
| --- | --- | --- | --- | --- | --- | --- |
| **gemini-3.5-flash-lite** | **100%** | 100% | 100% | 100% | 56% | $0.0037 |
| gemini-3.5-flash | 100% | 100% | 100% | 100% | 33% | $0.0203 |

flash-lite beats the larger model outright here — same 100% on every graded
dimension, better calibration, a fifth of the cost — so that is what ships. Every
remaining miss on both models is calibration on the same handful of rows
(`Mirza Loan`, `Trashman`): answered correctly, just more confidently than the
evidence warrants. `thinkingLevel: high` lifts calibration for 2× cost, worth it
only if the review queue feels too thin.

The benchmark imports the prompt the Edge Function actually deploys, so it cannot
drift from what runs in production.

```
npm run eval                  # graded benchmark, needs GEMINI_API_KEY
npm run eval -- <model...>    # compare models
COLD=1 npm run eval           # first-pass behaviour, no canonical entities yet
npm run eval:scale            # full 397-row backfill; checks nothing is dropped
```

## Development

```
npm install
npm run dev
npm run verify        # pure-logic checks, plus export-backed ones if present
npm run build         # also fails if a server-side key reaches dist/
```

The Bluecoins export is **not** in this repo — it is personal financial data, and
it is imported on the device via **Settings → Import**. Drop a
`TransactionsLatest.csv` in the repo root to unlock the export-backed assertions
in `verify` and `eval`; without it those sections skip and the rest still run.

`.env.local` needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` — see
`.env.example`. Those two are the only values allowed in the client. The Gemini
key and the Supabase service-role key exist only as Edge Function secrets, and
`scripts/check-build.mjs` fails the build if either ever appears in `dist/`.
