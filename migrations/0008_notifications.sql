-- 0008_notifications — the customer's inbox half of issue #14.
--
-- "The async loop only works if 'come back later' actually reaches the
-- customer." Digest-first, not instant: transactional email for exactly the
-- three states the Gate-A contract pins as sending (§ "Customer status
-- vocabulary") — `awaiting-signoff`, `needs-input`, `shipped` — and *only*
-- those three. Per-recipient quiet hours are an explicit v2 refinement
-- (issue #14) and are not modeled here.
--
-- `outbox` is the durable record of what the portal decided to send, not a
-- delivery log — this repo has no mail provider wired up yet, and nothing
-- black-box can observe a real inbox. A row here is read back by
-- `GET /outbox` (src/routes/outbox.ts) as the pinned `email-preview` DOM
-- (Gate-A contract, § `data-testid` hooks, Emails 11-13). Actually dispatching
-- the message (which provider, retries, bounces, SPF/DKIM) is out of scope for
-- this milestone and left as a follow-up.
--
-- `submission_id` holds the customer-visible `SUB-XXXXXX` reference, same
-- convention as `bridge_events` and `coord_facts` — this table's other half
-- lives on the customer side of the wall, not the daemon's.
--
-- The write site is `src/bridge/updates.ts`: one push that sets `status` to a
-- sending value, and whose own guarded status write actually lands (not
-- superseded by a concurrent push for a newer revision — see the
-- `meta.changes` check there), produces at most one row, deferred via
-- `ctx.waitUntil` past the same request that applied the status write.
-- `UNIQUE (submission_id, coord_revision)` is the second line of defence
-- behind the bridge's own `(submission_id, revision)` idempotency watermark (a
-- push already `already_applied` never reaches the insert at all) — belt and
-- braces against a daemon retry ever producing two emails for one transition,
-- which is exactly how "digest-first, not instant" would fail in practice.
CREATE TABLE IF NOT EXISTS outbox (
  id             TEXT PRIMARY KEY,
  submission_id  TEXT NOT NULL,
  email_type     TEXT NOT NULL CHECK (email_type IN ('signoff-ready', 'needs-input', 'shipped')),
  to_email       TEXT NOT NULL,
  from_email     TEXT NOT NULL,
  subject        TEXT NOT NULL,
  preheader      TEXT NOT NULL,
  body           TEXT NOT NULL,
  cta_text       TEXT NOT NULL,
  cta_href       TEXT NOT NULL,
  coord_revision INTEGER NOT NULL,
  sent_at        TEXT NOT NULL,
  UNIQUE (submission_id, coord_revision)
);

-- `GET /outbox` scopes by the caller's Access identity (issue #12's rule,
-- applied here the same way `idx_submissions_customer_email` applies it to the
-- dashboard) — one customer's send must never be readable by another's
-- request.
CREATE INDEX IF NOT EXISTS idx_outbox_to_email ON outbox (to_email);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0008')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
