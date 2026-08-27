# Auto-capture: forward payment notifications into Hisaab

Hisaab turns a payment notification (easypaisa, NayaPay, an HBL SMS, a bank
alert) into a **To be resolved** item — you only say what the money was for.
There are three ways a notification gets in; the first two need no setup.

1. **Paste** — tap *Paste a message* on the home screen and paste the text.
2. **Share** — with Hisaab installed to the home screen, share a notification (or
   its copied text) from Android's share sheet straight into the app.
3. **Auto-forward** — an automation app posts every matching notification on its
   own, so captures appear with no action at all. This is the "flawless" path,
   and it is what the rest of this document sets up. Allow fifteen minutes, once.

**Your financial data still never leaves the device except as the raw
notification text you choose to forward**, and even that lands in a private,
RLS-scoped table only your signed-in app can read.

## What you're building

```
easypaisa / NayaPay / HBL notification
      │  (Notification Access, or the SMS trigger)
MacroDroid / Tasker / HTTP Shortcuts on your phone
      │  HTTPS POST — token in a header, notification as the body
Supabase Edge Function  `ingest`   ── service role ──►  payment_inbox (your row)
      │
Hisaab (signed in)  pulls the row over RLS, parses it locally, deletes it
      │
"To be resolved" on the home screen
```

Nothing on the server ever interprets the message. The Edge Function checks that
the token belongs to somebody and stores the text; the amount, the direction and
the meaning are all worked out on your phone, in the app.

## Part 1 — the server (already done)

The migration is applied and the function is deployed on the live project, so
**skip to Part 2**. This section is here for a rebuild, or for a second Supabase
project.

```bash
supabase db push                                   # ingest_tokens + payment_inbox
supabase functions deploy ingest --no-verify-jwt   # the receiving endpoint
```

`--no-verify-jwt` is required: the caller is an automation carrying a token, not
a signed-in user, and it cannot hold a Supabase session. `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are injected into deployed functions automatically —
nothing else to configure, and no secret ships to the browser.

## Part 2 — the app (2 minutes)

1. Open Hisaab → **Settings**.
2. Under **Sync**, make sure you are signed in. Auto-capture needs an account:
   the token is what ties a forwarded message to it.
3. Scroll to **Auto-capture** → tap **Generate my token**.
4. Two values appear. Keep the page open, or copy both into a note — you are
   about to paste them into MacroDroid:
   - **Endpoint** — the URL, ending in `/functions/v1/ingest`
   - **Your token** — a long random string
5. Turn on **Pull forwarded messages into the inbox**. Until this is on the app
   never polls, so a phone that has not been set up costs nothing.

> Generating a new token replaces the old one. That is also how you revoke a
> phone you no longer have: generate again, and the old token stops working.

## Part 3 — MacroDroid, the notification macro

MacroDroid is the easiest of the three. Install it from Play, open it once, and
let it finish its own setup screen.

### 3.1 Grant Notification Access

MacroDroid cannot see notifications until Android lets it.

1. MacroDroid → ☰ menu → **Settings** → **Permissions**, or Android **Settings →
   Apps → Special app access → Notification access**.
2. Enable **MacroDroid** and confirm the warning Android shows.

While you are in Android settings, also exclude MacroDroid from battery
optimisation (**Settings → Apps → MacroDroid → Battery → Unrestricted**).
Without it Android eventually stops the listener and captures go quiet — this is
the single most common reason auto-capture "worked for a week and then stopped".

### 3.2 Create the macro

**Add Macro (+)**, and name it `Hisaab capture`.

**Trigger** → **Device Events** → **Notification** → **Notification Received**.

- **Applications**: select only the ones that move money — *easypaisa*,
  *NayaPay*, your bank's app. Never "All applications": you would forward every
  WhatsApp message you receive.
- **Text content**: *Contains text* → `Rs`. Add a second trigger for `PKR` if
  your bank writes it that way. This one filter keeps delivery reports, promos
  and "your bill is due" alerts out of the inbox.
- Leave **Exclude ongoing** ticked if it is offered; a persistent notification
  would otherwise re-fire on every update.

**Action** → **Connectivity** → **HTTP Request**.

| Field | Value |
| --- | --- |
| Method | **POST** |
| URL | your **Endpoint**, with `?app={not_app_name}` appended |
| Content type | **text/plain** (*Plain text*, or *Custom* → `text/plain`) |
| Body | `{not_title} {notification}` |
| Header | name `X-Ingest-Token`, value **your token** |

So the URL reads:

```
https://YOUR-PROJECT.supabase.co/functions/v1/ingest?app={not_app_name}
```

`{notification}`, `{not_title}` and `{not_app_name}` are MacroDroid **magic
text**. Insert them with the `{}` button beside the field rather than typing
them, so you get the exact spelling your version uses.

**Why the token is a header and the body is plain text.** A bank SMS arrives
with line breaks, and payee names sometimes carry a quotation mark. Pasted into
a hand-built JSON body, either one makes the request unparseable and the capture
is lost without a sound. As raw text there is nothing to escape. The endpoint
still accepts JSON and form-urlencoded — see *Other request shapes* — but this
is the shape that cannot be broken by the message it carries.

**Constraints** → none. Leave it empty and **save**.

### 3.3 A second macro, for bank SMS

Bank alerts that arrive as SMS are better read from the message itself than from
the Messaging app's notification, which Android truncates.

**Add Macro (+)**, named `Hisaab capture (SMS)`.

- **Trigger** → **Device Events** → **SMS Received**. Restrict the sender to
  your bank's shortcode if you know it — HBL sends from `14250` — otherwise
  leave it open and rely on the text filter.
- **Text content**: *Contains text* → `PKR`.
- **Action**: the same HTTP Request as above, with two changes:
  - URL `…/functions/v1/ingest?app={sms_number}`
  - Body `{sms_message}`

If the trigger never fires, open its options and enable **Monitor inbox**; some
Android builds do not deliver the broadcast the normal trigger listens for. RCS
/ "Chat" messages are not SMS and cannot be read this way at all.

### 3.4 Test it

1. Send yourself Rs 1 on NayaPay or easypaisa. Faster: use the macro's **Test
   Actions** button with a real notification's text pasted into the body for the
   one run.
2. MacroDroid → ☰ → **System Log** should show the macro firing and the response
   `200 {"ok":true}`.
3. Open Hisaab. It appears under **To be resolved** on the home screen within a
   few seconds. Tap it, say what it was for, save.

`401 unknown token` means the header token no longer matches Settings — usually
because a newer one was generated afterwards. `400` means the body arrived
empty, which usually means the magic text was typed by hand and did not resolve.

## Part 3b — Tasker and HTTP Shortcuts

The request is identical; only the variables differ.

**Tasker** needs the **AutoNotification** plugin to read other apps'
notifications — Tasker's own event does not expose their text on modern Android.

- Profile → **Event** → **Plugin** → *AutoNotification Intercept*, filtered to
  the payment apps.
- Task → **Net** → **HTTP Request**: method `POST`, URL your endpoint with
  `?app=%anappname`, header `X-Ingest-Token:YOUR_TOKEN`, content type
  `text/plain`, body `%antitle %antext`.
- Those variable names differ between AutoNotification versions — take them from
  the plugin's own variable list rather than from here.

**HTTP Shortcuts** works from its own notification trigger or driven by Tasker:
one shortcut, method POST, your endpoint as the URL, request body type *plain
text*, and the token as a static `X-Ingest-Token` header.

## Other request shapes

All three are accepted, so use whichever your automation app makes easy.

```
POST /functions/v1/ingest?app=easypaisa
X-Ingest-Token: YOUR_TOKEN
Content-Type: text/plain

Rs. 675 sent to AWAIS IQBAL …
```

```
POST /functions/v1/ingest
Content-Type: application/json

{ "token": "YOUR_TOKEN", "body": "Rs. 675 sent to …", "app": "easypaisa" }
```

```
POST /functions/v1/ingest
Content-Type: application/x-www-form-urlencoded

token=YOUR_TOKEN&body=Rs.%20675%20sent%20to%20…&app=easypaisa
```

A token in the header or the query string wins over one in the body.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Nothing ever arrives | *Pull forwarded messages* is off in Settings, or you are signed out. |
| `401 unknown token` | The header token is stale. Copy the current one from Settings. |
| `400 a message body is required` | Magic text did not resolve. Pick it from MacroDroid's list instead of typing it. |
| Worked, then stopped | Battery optimisation killed the listener. Set MacroDroid to **Unrestricted**. |
| OTPs and promos in the inbox | Add the *Contains text* filter (`Rs` / `PKR`) to the trigger. |
| A message arrives but no capture appears | It carried no amount, so it was dropped rather than retried forever. |
| Everything twice | The notification macro and the SMS macro both matched. Restrict one of them. |

## Notes

- The app only **pulls** when *Pull forwarded messages* is on, so a device
  without setup never polls a table it may not have.
- A forwarded message that cannot be parsed is deleted rather than retried
  forever.
- Nothing forwarded is ever spending until you resolve it on the device. The
  server relays text; it decides nothing.
