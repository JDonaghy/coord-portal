-- 0021_outbox_approval — issue #162 (EM-2 of milestone #5, epic #160): "hold
-- a reply for approval" — approval_state on outbox, one clause in the drain.
--
-- This migration only makes "this reply is waiting for a human" a
-- representable, unsendable state — the same posture
-- `migrations/0010_outbox_delivery_state.sql` took for delivery state: make
-- it representable first, move rows later. No code in this change ever
-- writes a row with `approval_state != 'not_required'` — that is a future
-- milestone's job once there is an intake-reply draft to actually gate.
--
-- ── approval_state: A NEW AXIS, NOT A FOURTH `status` ───────────────────────
-- The obvious move is a fourth `status` value ("pending-approval" or
-- similar). That is wrong for a reason that will not show up in review as a
-- test failure: `status` is the three fixed slugs pinned by ms-3's sealed
-- contract (§ "Delivery state vocabulary") and by 0010's own `CHECK`, and
-- `src/notifications.ts`'s `fromRow` returns `null` for any `status` it does
-- not recognise — both `listOutboxForCustomer` (`/outbox`) and
-- `listAllOutbox` (`/deliveries`) then silently drop the row. A new `status`
-- slug does not fail loudly; it makes rows vanish.
--
-- Approval is a different question from delivery — "is a human allowed to
-- let this go out" is orthogonal to "did the provider accept it" — so it
-- gets its own column, the same way `claimed_at`
-- (`migrations/0011_outbox_claim_lease.sql`) got its own column instead of
-- becoming a fourth `status` for the same reason.
--
-- `DEFAULT 'not_required'` is load-bearing: every existing row, and every
-- existing enqueue path (`recordNotificationForStatus`, the only writer of
-- `outbox` rows today), is untouched by this migration — the four existing
-- notification types keep sending unattended, with no separate backfill
-- UPDATE, and ms-1's and ms-3's sealed suites stay green with no edit.
--
-- `approved_at` / `approved_by` are bookkeeping for the future approve/reject
-- action (out of scope here — "no UI, no new sends, no new callers"): who
-- signed off and when, set together the moment a `pending` row moves to
-- `approved` or `rejected`. Both nullable, both untouched by this migration
-- for the same reason `approval_state` defaults the way it does.
ALTER TABLE outbox ADD COLUMN approval_state TEXT NOT NULL DEFAULT 'not_required'
  CHECK (approval_state IN ('not_required', 'pending', 'approved', 'rejected'));
ALTER TABLE outbox ADD COLUMN approved_at TEXT;
ALTER TABLE outbox ADD COLUMN approved_by TEXT;

-- ── WIDENING outbox.email_type (again) ──────────────────────────────────────
-- Issue #162 also widens `email_type` to admit a fifth sending type,
-- `intake-reply` — the thing `approval_state` exists to gate, once a future
-- milestone actually starts writing rows of this type. `src/notifications.ts`
-- adds it to `SENDING_TYPES` in this same change: that module's `fromRow`
-- drops any row whose `email_type` it does not recognise, so a migration
-- that landed without the matching code change would make intake replies
-- invisible to both `/outbox` and `/deliveries` the moment anything ever
-- inserted one — the exact failure mode this migration's own `CHECK` widening
-- and the `notifications.ts` edit must land together to avoid.
--
-- SQLite has no `ALTER TABLE ... ADD CONSTRAINT` / `DROP CONSTRAINT`, so
-- widening a `CHECK` means the documented rebuild `migrations/0015_preview_reviews.sql`
-- already established for this exact table and this exact column: create the
-- replacement table with the new CHECK (and carrying the three columns just
-- added above), copy every row across unchanged, drop the old table, rename
-- the new one into its place. Every other column, default and index carries
-- over verbatim — this is a constraint change, not a data or shape change,
-- and no application code needs to know it happened.
CREATE TABLE outbox_new (
  id                   TEXT PRIMARY KEY,
  submission_id        TEXT NOT NULL,
  email_type           TEXT NOT NULL
    CHECK (email_type IN ('signoff-ready', 'needs-input', 'shipped', 'preview-ready', 'intake-reply')),
  to_email             TEXT NOT NULL,
  from_email           TEXT NOT NULL,
  subject              TEXT NOT NULL,
  preheader            TEXT NOT NULL,
  body                 TEXT NOT NULL,
  cta_text             TEXT NOT NULL,
  cta_href             TEXT NOT NULL,
  coord_revision       INTEGER NOT NULL,
  queued_at            TEXT NOT NULL,
  sent_at              TEXT,
  status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  provider_message_id  TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  claimed_at           TEXT,
  approval_state       TEXT NOT NULL DEFAULT 'not_required'
    CHECK (approval_state IN ('not_required', 'pending', 'approved', 'rejected')),
  approved_at          TEXT,
  approved_by          TEXT,
  UNIQUE (submission_id, coord_revision)
);

INSERT INTO outbox_new
  (id, submission_id, email_type, to_email, from_email, subject, preheader, body, cta_text, cta_href,
   coord_revision, queued_at, sent_at, status, provider_message_id, attempts, last_error, claimed_at,
   approval_state, approved_at, approved_by)
SELECT
  id, submission_id, email_type, to_email, from_email, subject, preheader, body, cta_text, cta_href,
  coord_revision, queued_at, sent_at, status, provider_message_id, attempts, last_error, claimed_at,
  approval_state, approved_at, approved_by
FROM outbox;

DROP TABLE outbox;
ALTER TABLE outbox_new RENAME TO outbox;

-- Recreated exactly as 0009/0010/0011/0015 left them — the rebuild drops
-- every index along with the table it belonged to.
CREATE INDEX IF NOT EXISTS idx_outbox_to_email ON outbox (to_email);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status);
CREATE INDEX IF NOT EXISTS idx_outbox_status_claimed_at ON outbox (status, claimed_at);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0021')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
