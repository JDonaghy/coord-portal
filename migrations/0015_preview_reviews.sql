-- 0015_preview_reviews — the pre-merge preview approval gate (issue #107).
--
-- `SUB-C467AA` merged and deployed before any `shipped` notification went
-- out, and the customer found real issues on the live build before we did —
-- there was no gate between "merged" and "customer told it's done", and
-- approval was verbal, not tracked. Since then, natal-chart migrated to
-- Cloudflare Pages (#30, #31), which gives every PR a real, unique preview
-- URL. `deploy-cloudflare.yml` builds identically for PR previews and
-- production, so a PR's preview *is* what will ship if approved unchanged —
-- this migration is the storage half of turning that into a real,
-- pre-merge customer approval step instead of a verbal one.
--
-- ── preview_url: A COLUMN, NOT coord_facts ──────────────────────────────────
-- `preview_url` is coordinator-owned (see `src/bridge/ownership.ts`) — the
-- operator pushes it alongside `status: 'quality-check'` once a PR's preview
-- is ready for the customer to look at, the same push shape `status` itself
-- already uses. It gets a real column, written directly by
-- `src/bridge/updates.ts` the same way `status` is, rather than going through
-- the generic `coord_facts` last-value mirror (0003): every reader that needs
-- it — the submission detail screen, this migration's own `preview_reviews`
-- lookup — wants a plain column to join against, not a JSON-encoded fact row.
-- A single current value is enough for v1 (no versioned preview-history
-- table): the PR itself is the history, and a fresh `preview_url` push simply
-- reopens the pending state (see `preview_reviews` below) the same way a new
-- design round does, just without a round counter.
ALTER TABLE submissions ADD COLUMN preview_url TEXT;

-- The customer's verdict on one preview build — the portal-owned half of the
-- gate. Kept as its own table rather than folded into `signoffs` (0006):
-- 0006's own module comment already establishes this schema's answer to "two
-- related-but-distinct customer decisions" is two tables, not one table with
-- an extra discriminator column (see `signoffs` vs. `question_answers`, 0004)
-- — a preview review is a different decision from a design round's sign-off
-- (a real, running build, not a mock), even though the UI shape mirrors it.
--
-- Not versioned by a round number — there is no round to be one of. Instead,
-- one row per (submission, preview_url) pair, `PRIMARY KEY`, exactly the shape
-- `signoffs` already uses for (submission, round): a preview_url is "pending"
-- from the moment it is pushed until a review row for that *exact* URL
-- exists. The operator queuing a *new* preview_url (after a fix in response
-- to "changes requested") makes the previous URL's review moot and opens a
-- fresh pending state for the new one — no round counter needed because the
-- URL itself is the natural key. See `src/previewReviews.ts`.
--
-- `comment` is set only on `changes-requested`, the same rule `signoffs.comment`
-- already follows — approving asks for no comment.
CREATE TABLE IF NOT EXISTS preview_reviews (
  submission_id  TEXT NOT NULL,     -- the customer-visible SUB-XXXXXX reference
  preview_url    TEXT NOT NULL,
  verdict        TEXT NOT NULL CHECK (verdict IN ('approved', 'changes-requested')),
  comment        TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (submission_id, preview_url)
);

-- ── WIDENING outbox.email_type ──────────────────────────────────────────────
-- Issue #14's `outbox.email_type` CHECK (0009) pins exactly three sending
-- states. #107 adds a fourth: `preview-ready` (src/notifications.ts), sent
-- when a submission reaches `quality-check` — the third and last of the
-- customer-actionable-or-terminal states this portal ever emails on, mirroring
-- `signoff-ready` linking to the portal submission page rather than the raw
-- preview URL directly.
--
-- SQLite has no `ALTER TABLE ... ADD CONSTRAINT` / `DROP CONSTRAINT`, so
-- widening a `CHECK` means the documented rebuild: create the replacement
-- table with the new CHECK, copy every row across unchanged, drop the old
-- table, rename the new one into its place. Every other column, default and
-- index carries over verbatim — this is a constraint change, not a data or
-- shape change, and no application code needs to know it happened.
CREATE TABLE outbox_new (
  id                   TEXT PRIMARY KEY,
  submission_id        TEXT NOT NULL,
  email_type           TEXT NOT NULL
    CHECK (email_type IN ('signoff-ready', 'needs-input', 'shipped', 'preview-ready')),
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
  UNIQUE (submission_id, coord_revision)
);

INSERT INTO outbox_new
  (id, submission_id, email_type, to_email, from_email, subject, preheader, body, cta_text, cta_href,
   coord_revision, queued_at, sent_at, status, provider_message_id, attempts, last_error, claimed_at)
SELECT
  id, submission_id, email_type, to_email, from_email, subject, preheader, body, cta_text, cta_href,
  coord_revision, queued_at, sent_at, status, provider_message_id, attempts, last_error, claimed_at
FROM outbox;

DROP TABLE outbox;
ALTER TABLE outbox_new RENAME TO outbox;

-- Recreated exactly as 0009/0010/0011 left them — the rebuild drops every
-- index along with the table it belonged to.
CREATE INDEX IF NOT EXISTS idx_outbox_to_email ON outbox (to_email);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status);
CREATE INDEX IF NOT EXISTS idx_outbox_status_claimed_at ON outbox (status, claimed_at);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0015')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
