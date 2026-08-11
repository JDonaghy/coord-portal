-- 0010_outbox_delivery_state — issue #49: "outbox records what the portal
-- decided to send, but a row has no delivery state — nothing distinguishes
-- 'not sent yet' from 'sent' from 'gave up'."
--
-- This migration only makes that state REPRESENTABLE (#49's own "Out of
-- scope": "Actually calling a provider (#B/#C)... only makes the state
-- representable and visible"). No code in this change ever moves a row past
-- `queued` — that is #50 (the cron drain) and #51 (the provider seam).
--
-- `status` — the vocabulary the Gate-A contract pins (§ "Delivery state
-- vocabulary"): `queued` (decided, not yet delivered — fresh or mid-retry,
-- indistinguishable to the customer), `sent` (provider accepted it), `failed`
-- (every retry exhausted, terminal). Every existing row predates this column
-- and was, by definition, never claimed by a drain that didn't exist yet —
-- `DEFAULT 'queued'` backfills them correctly with no separate UPDATE needed.
--
-- `provider_message_id` — what the provider returned on success, so "a
-- delivery question can be answered later" (#49's own words) without this
-- milestone rendering it anywhere customer-facing (contract § "Why
-- provider-message-id is not on the customer page").
--
-- `attempts` / `last_error` — the retry/give-up bookkeeping #50's drain will
-- own. `last_error` is the raw provider/operator string; contract §
-- "Customer-safe error copy" is explicit that this column is never rendered
-- verbatim on the customer-scoped `/outbox` route.
--
-- `sent_at`'s meaning collides with what this table already stores under that
-- name: `0009_notifications.sql` set `sent_at` at INSERT time — decision time,
-- "not a delivery log" per its own comment — and `GET /outbox` orders by it.
-- #49 asks for a `sent_at` that means DELIVERY time. Per the Gate-A contract's
-- own Notes item 1, this is a genuine conflict in the issue text, not silently
-- picked one way — resolved here by keeping the existing column, renamed to
-- `queued_at`, as the creation-order key `listOutboxForCustomer` sorts by
-- (Notes item 2: ordering stays "oldest by whatever the implementer uses for
-- creation order", unchanged from ms-1), and adding a distinct new nullable
-- `sent_at` that only #50's drain ever populates, only when `status` becomes
-- `sent`. Every row that predates this migration keeps its original
-- decision-time value under `queued_at`; `sent_at` starts NULL for all of
-- them, which is correct — none of them has actually been delivered by any
-- provider yet.
ALTER TABLE outbox RENAME COLUMN sent_at TO queued_at;

ALTER TABLE outbox ADD COLUMN sent_at TEXT;
ALTER TABLE outbox ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'
  CHECK (status IN ('queued', 'sent', 'failed'));
ALTER TABLE outbox ADD COLUMN provider_message_id TEXT;
ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN last_error TEXT;

-- The operator delivery view (#55) and the drain (#50) will both want to find
-- work/stuck rows by status; the customer route still filters by `to_email`
-- first (idx_outbox_to_email, unchanged from 0009).
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0010')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
