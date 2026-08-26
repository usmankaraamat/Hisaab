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

## Capture from a notification

The hardest part of an entry — the amount, and which way the money went — is
already sitting in the payment notification easypaisa, NayaPay, or a bank just
sent you. So a notification becomes a **To be resolved** item on the home screen,
and the only thing left is to say what the money was for. One payment can be
split across several things: the line items have to add back to the amount that
actually moved, the same rule shared expenses already follow.

`src/capture/notif.js` reads the real formats — `You have Received Rs. 50.00 from
Bank BAF`, `Rs. 675.0 … sent to AWAIS IQBAL via Raast`, an HBL SMS — pulling out
the amount (never the `Fee … Rs. 0.00` line), the direction, the counterparty and
the date. Nothing is a category yet; the meaning is still the person's to give.

Three ways in, in order of how little they ask:

- **Auto-forward.** A phone automation posts each notification to a private,
  RLS-scoped endpoint; the app pulls and parses it. Captures appear with no
  action at all. Ten-minute one-time setup — see [`docs/auto-capture.md`](docs/auto-capture.md).
- **Share.** With Hisaab installed, share a notification from Android's share
  sheet straight into the inbox.
- **Paste.** Tap *Paste a message* and paste the text.

Everything but auto-forward needs no server and no setup, and even auto-forward
only ever relays the raw text you choose to forward.

## Rules, budgets, recurring, and Ask

Four smaller conveniences layer onto the same offline, private core:

- **Rules** — "anything containing *indrive* is Rides." Set the category once, at
  capture, and the model never re-decides it. Fixing a category in History offers
  to remember it as a rule, so corrections teach the app.
- **Category budgets** — a monthly cap per category, with a progress bar on the
  Spending tab and an over-budget flag (the reserved critical colour plus an
  explicit "over by", never colour alone).
- **Recurring** — tell the app about rent or a subscription and its occurrence
  drops into the inbox when due, for a one-tap confirm. It never logs money that
  may not have moved.
- **Ask** — a one-line question box over the local ledger ("how much on eating out
  last month", "who owes me the most"), answered on the device with no model and
  no data leaving the phone.

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

Savings is netted, not accumulated: redeeming part of it reopens the gap to the
target. A figure that can only ever grow is not a target.

What you owe reduces `safe`; what is owed *to* you does not increase it. It may
never come, and a spending limit should not be inflated by an optimistic
assumption. Both figures are the Ledger's own — see below.

`safe ÷ days left` sits under the capture input, because that is the only place a
number can change a decision. The period is the calendar month, anchored to the
first weekday — the 1st, or the following Monday when the 1st is a weekend, since
pay dated the 1st only clears once the bank reopens. It was once anchored to the
last income entry instead, on the theory that a salary landing on the 3rd makes
"this month" the wrong window; but that made reconciling mid-month re-stamp the
start of the period, drop the salary out of it, and leave the balance reading
negative. Pay lands on the 1st, so the month is the right window, and fixing it
there is what lets reconciling be a correction rather than a reset — see below.

The savings target is deducted **before** the allowance, not left over after it.
Saving what remains at the end of the month is exactly the thing that does not
work.

## Reconciling is a correction, not a reset

Tracked balances drift — a missed entry, a rounding, a note handed over and
forgotten. **Settings → Count your cash** takes what you actually hold and
records the difference as a single **Reconcile cash** row: an incoming entry when
you held more than tracked, an outgoing one when you held less. Cash then matches
what you counted, and because it is an ordinary dated row inside the current
period, the period never moves.

That is the whole fix for a long-standing bug. Reconciling used to re-stamp the
opening balance to *now*, which restarted the period and dropped the month's
salary out of it, so the balance dived negative straight after a count. A
correction row leaves the salary where it is.

A Reconcile cash row is deliberately kept out of `spend`, the breakdown and the
daily allowance: it is neither something earned nor something bought, only the
gap between the ledger and your pocket. It still shows in History, so the
adjustment is visible rather than silent.

## Seeing spending by date

The Spending breakdown and History both carry a start/end date range, defaulting
to the current period. A category bar used to total every matching row for all
time, so tapping "5,000 on Eating Out" could open 20,000 of entries with 15,000
of it from earlier months — the figure and its drill-down disagreed. Both are now
scoped to the same window, and the range travels with the link, so what you tap
and what you land on are always the same set. Pick any earlier month to read its
breakdown the same way.

The capture screen carries the running totals that actually shape a habit —
**today**, **this week**, **this month** — in place of a list of recent rows,
which History already holds. "Spending" there means exactly what the Spending tab
counts: savings, transfers, money still owed and reconciliation corrections are
all left out.

## One number, one home

Spending and the Ledger used to both report what people owed, netted by slightly
different rules, and they disagreed: one sister read 4,050 on one screen and
4,600 on the other. The difference was whatever she had bought *for* the user —
real, but invisible unless you knew to look for it. Two views of one number is
worth less than one number.

So the division is absolute:

- **Anything still owed**, in either direction, is the Ledger's and appears in no
  figure on Spending. It is an asset, not an expense — money that left the wallet
  but is coming back.
- **Anything written off** has stopped being a balance and become an expense. It
  appears on Spending under a single **On other people** heading, and nowhere
  else.

Writing a row off in the Ledger is therefore the one action that moves money
across the line, which is also what it means in plain English: you have decided
you are not getting it back.

That heading is one row rather than a share of Groceries, Health and Shopping,
because mixed in it buried the habit worth seeing — a quarter of the live
breakdown across six categories, with Groceries alone at 5,310 of 12,885. The
line is drawn on the counterparty, not the ledger effect: a treat written off as
a gift still was not shopping for you, and neither was a present the model tagged
with a person but no debt.

Tapping a category on Spending opens History filtered to exactly the rows that
bar counted, so a real category means *your* groceries. What you bought for
other people is reachable under **On other people**, under **Owed back to you**,
or by person.

## Overview

Spending and saving over time, drilled month → week → day. The chart is inline
SVG — two series of at most twelve bars, under a hundred lines — because a
charting dependency would outweigh the entire app.

Weeks are blocks of seven from the 1st, not ISO weeks. An ISO week straddles the
month boundary, which would put the same day in two months and stop the weeks
adding up to the month above them. The list under the chart carries the exact
numbers and is what you tap to drill, so the bars never have to be a hit target.

Series colours are validated for contrast and colour-vision deficiency against
both surfaces, and identity never rests on colour alone: there is a legend, the
list names every bar, and imported bars are hatched as well as faded.

**Calendar, not payday.** Everywhere else a period runs from one income to the
next, because that is what a spending limit is measured against. Overview is
history, so August has to mean August. The two disagree by a few days on purpose.

## What is imported, and what is measured

The Bluecoins export is kept as reference and quarantined from everything that
claims to mean something. That period was lived with flatmates covering each
other's expenses and the logging has real gaps, so its totals are not comparable
with anything tracked here.

`source` is the line. Imported rows are excluded from the Spending screen, the
Ledger, the allowance, the savings pot and every month-over-month comparison.
Overview draws them, faded and hatched and labelled — seeing them is the one
thing they are good for.

A month holding both kinds describes itself with the tracked ones. The export
overlaps the first days of the month the app started; greying out the only month
actually measured because three imported rows landed in it would be the wrong
trade.

## Savings

`savingsPot` is a running balance: every amount logged as savings, less every
withdrawal, for all time. It is driven only by what was logged — never inferred
from income minus spending, which would move on its own whenever anything else
changed — and it never resets. A salary landing should not wipe out months of
visible progress.

The per-period target is a separate thing and stays per-period, because a monthly
target has to be measured against a month; the card labels it as such. The
**goal** — a name, an amount, a date — is measured against the pot, and reports
when you arrive at your current rate.

`suggestedTarget` proposes a figure from your *worst* complete month rather than
your average. A target you hit half the time stops being a target.

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
