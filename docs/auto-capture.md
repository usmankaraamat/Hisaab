# Auto-capture: forward payment notifications into Hisaab

Hisaab turns a payment notification (easypaisa, NayaPay, an HBL SMS, a bank
alert) into a **To be resolved** item — you only say what the money was for.
There are three ways a notification gets in; the first two need no setup.

1. **Paste** — tap *Paste a message* on the home screen and paste the text.
2. **Share** — with Hisaab installed to the home screen, share a notification (or
   its copied text) from Android's share sheet straight into the app.
3. **Auto-forward** — an automation app posts every matching notification on its
   own, so captures appear with no action at all. This is the "flawless" path,
   and it takes about ten minutes to set up once.

This document is the auto-forward setup. **Your financial data still never leaves
the device except as the raw notification text you choose to forward**, and even
that lands in a private, RLS-scoped table only your signed-in app can read.

## What you're building

```
easypaisa / NayaPay / HBL notification
      │  (NotificationListener)
MacroDroid / Tasker / HTTP Shortcuts on your phone
      │  HTTPS POST { token, body, app }
Supabase Edge Function  `ingest`   ── service role ──►  payment_inbox (your row)
      │
Hisaab (signed in)  pulls the row over RLS, parses it locally, deletes it
      │
"To be resolved" on the home screen
```

## One-time server setup (developer)

You need the Supabase CLI linked to your project.

```bash
# 1. Apply the migration that adds ingest_tokens + payment_inbox
supabase db push

# 2. Deploy the ingest function. --no-verify-jwt because the caller is an
#    automation carrying a token, not a signed-in user.
supabase functions deploy ingest --no-verify-jwt
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into deployed
functions automatically — nothing else to configure, and no secret ships to the
browser.

## In the app

1. Make sure **Sync** is set up and you are signed in (Settings → Sync).
2. Settings → **Auto-capture** → *Generate my token*. This stores a random token
   and registers it against your account. Copy the **Endpoint** and **token**.
3. Turn on **Pull forwarded messages into the inbox**.

## On the phone (MacroDroid example)

MacroDroid is the easiest; Tasker and HTTP Shortcuts work the same way.

1. New Macro → **Trigger**: *Notification Received*. Restrict it to the apps you
   want: easypaisa, NayaPay, and the Messaging app for HBL SMS.
2. **Action**: *HTTP Request*.
   - Method: **POST**
   - URL: your **Endpoint** (`…/functions/v1/ingest`)
   - Content type: **application/json**
   - Body:
     ```json
     {
       "token": "YOUR_TOKEN",
       "body": "[notification]",
       "app": "[app_name]"
     }
     ```
     Use MacroDroid's magic text: `[notification]` for the notification text and
     `[app_name]` for the posting app. (In Tasker these are `%evtprm()` /
     `%anapp`; in HTTP Shortcuts, the notification variables.)
3. Save. Send yourself a rupee on NayaPay to test — it should appear in
   **To be resolved** within a few seconds of the app being open (or on next
   sync).

## Notes

- The app only **pulls** when *Pull forwarded messages* is on, so a device
  without setup never polls.
- A forwarded message that can't be parsed (no amount) is dropped rather than
  looping forever.
- Revoke a device by deleting its token: generate a new one, which replaces it.
- OTP and non-payment notifications are ignored automatically (no amount to log).
