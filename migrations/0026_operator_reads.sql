-- 0026_operator_reads — issue #304: an operator viewing a customer's own
-- design-round material (the published mock bundle, and the round history
-- with its verdict and comment) is the first place in this portal where one
-- person reads another person's private material rather than their own.
-- Every other operator screen (`/leads`, `/deliveries`, `/requests`) reads
-- facts the portal itself already surfaces to an operator by design — a lead
-- nobody has claimed yet, a delivery outcome, a pipeline status. This is
-- different: it is the customer's own words, and the bundle they were shown,
-- read by someone who is not them. The issue is explicit that this access
-- "should leave a trace rather than being silent" — this table is that trace.
--
-- ── WHY A NEW TABLE, NOT `bridge_events` OR `lifecycle_events` ─────────────
-- Both of those record something the *coordinator* said, arriving over the
-- bridge with a `coord_revision` to key idempotency against. This records
-- something an *operator* did, entirely portal-side, with no push and no
-- revision — the shape those tables are built around does not fit. `messages`
-- is the nearest cousin (a portal-authored row keyed by submission), but a
-- message is content two parties exchange and is rendered back to both of
-- them; this is a read, and recording a read has no author-facing rendering
-- at all — nobody ever sees this table on screen, unlike every row in
-- `messages`.
--
-- ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
-- No IP address, no user agent, no request id — an operator's own email and
-- when they looked is enough to answer "who read this customer's material,
-- and when", which is the only question this table exists to answer. `round`
-- is nullable: a read of the round list (`GET /requests/:id/rounds`) names no
-- single round; a read of one round's mock bundle
-- (`GET /requests/:id/rounds/:n/mock`) names exactly one.
--
-- ── AND WHAT NEVER WRITES HERE ─────────────────────────────────────────────
-- The customer's own, ordinary `isOwnedBy`-gated routes
-- (`GET /submissions/:id/rounds`, `GET /submissions/:id/rounds/:n/mock`) never
-- insert a row — an owner reading their own submission is not the event this
-- table exists to record. See `src/operatorAccess.ts`'s own doc comment for
-- the two call sites that do.
CREATE TABLE IF NOT EXISTS operator_reads (
  id             TEXT PRIMARY KEY,
  operator_email TEXT NOT NULL,
  submission_id  TEXT NOT NULL,     -- the customer-visible SUB-XXXXXX reference
  round          INTEGER,           -- set only for a read of one round's mock bundle
  occurred_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_reads_submission
  ON operator_reads (submission_id, occurred_at);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0026')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
