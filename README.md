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

## Model choice is measured, not assumed

`scripts/eval/` grades the enrichment prompt against 66 real entries chosen for
being hard: route direction (`Flat → Office` ≠ `Office → Flat`), a word that is a
person in one entry and a place in another (`Anser Farewell` vs `Indrive
Anser-NUST`), gifts that look like loans (`Pizza for sister`), typos
(`Yango Flat-Offic`), and entries terse enough that low confidence is the correct
answer (`Washroom`).

| model | overall | routes | ledger | calibration | cost / 66 rows |
| --- | --- | --- | --- | --- | --- |
| **gemini-3.5-flash-lite** | **100%** | 100% | 100% | 56% | $0.0027 |
| gemini-3.5-flash | 100% | 100% | 100% | 56% | $0.0147 |
| gemini-3.6-flash | 99% | 100% | 100% | 100% | $0.0091 |
| gemini-3.1-flash-lite | 99% | 98% | 100% | 89% | $0.0038 |

flash-lite matches the larger model's miss profile at a fifth of the cost, so
that is what ships. `thinkingLevel: high` lifts calibration to 89% for 2× cost —
worth it only if the review queue feels too thin.

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
