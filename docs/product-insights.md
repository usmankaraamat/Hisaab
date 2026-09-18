# Product insights

The apps send one small, first-party activity record per active installation and
day while **Share anonymous usage counts** is enabled. The record contains only:

- app name and a random installation ID;
- whether that installation has logged anything;
- whether it is signed in;
- whether it is configured for hosted providers or BYOK.

It never includes meals, transactions, amounts, descriptions, provider keys, or
precise location. Clearing browser storage creates a new installation ID, so
installation counts are an estimate of people rather than an identity system.

In the Supabase SQL editor, use:

```sql
select * from product_usage_summary;
select * from product_usage_daily;
select * from product_feedback_inbox;
```

`product_usage_summary` shows DAU, WAU, MAU, activated installations,
signed-in accounts, hosted users, and BYOK users. `product_usage_daily` is the
day-by-day history. `product_feedback_inbox` contains ratings, messages, reply
addresses when supplied, and the review status.

The public client roles cannot read these tables or views. Anonymous writes pass
through the `product-data` Edge Function, which validates input and limits each
installation to five feedback submissions per day.

