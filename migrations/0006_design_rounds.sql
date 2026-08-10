-- 0006_design_rounds — the versioned sign-off loop (issue #13).
--
--   In design -> Awaiting sign-off -> (changes requested) -> In design -> ... -> Signed off
--
-- Two tables, one per side of the wall, because the loop has exactly two
-- authors and the sole-writer table says which is which:
--
--   design_rounds   coord's proposal, mirrored read-only. `design_round`,
--                   `decomposition` and `artifacts` are all coord-owned
--                   (src/bridge/ownership.ts) — nothing in the portal ever
--                   authors a row here except by copying a bridge push.
--   signoffs        the customer's verdict. `signoff_verdict` and
--                   `signoff_comment` are portal-owned — coord may never write
--                   them, and the bridge already rejects the attempt.
--
-- ── WHY design_rounds EXISTS AT ALL, GIVEN coord_facts ─────────────────────
-- `coord_facts` (0003) is keyed by `(submission_id, field)`, so a second
-- `design_round` push *replaces* the first. That is exactly right for "what is
-- the current question" and exactly wrong here: issue #13's whole point is that
-- "rounds are versioned and every previous round stays readable — this is the
-- audit trail of what was agreed". A superseded round is never deleted, never
-- hidden and never edited; it keeps its own row, its own content and its own
-- verdict. `coord_facts` still receives the raw push (the bridge stores every
-- coord-owned field verbatim); this table is the append-only archive built from
-- it.
--
-- ── WHY THERE IS NO `status` COLUMN HERE, AND NO WRITE TO submissions.status ─
-- The contract says request-changes "returns the submission to In design" and
-- approve "is the only action that can move a submission past Awaiting your
-- sign-off". `status` is coord-owned, so the portal must never write it — a
-- two-writer field is the split-brain CLAUDE.md warns about. Both statements
-- are satisfied by *derivation* instead, the same trick the question channel
-- (0004) already uses for "is a question open": the customer-visible status is
-- a pure function of the stored coord status and the portal-owned verdict on
-- the newest round. See `derivedStatus` in src/rounds.ts.
--
-- ── ROUND NUMBERING ────────────────────────────────────────────────────────
-- 1-indexed and monotonically increasing per submission. A round stays *open*
-- until it has a verdict: coord's pushes revise the open round in place (it is
-- still coord's own unsigned proposal), and the first push after a verdict
-- lands opens round N+1. That is "request changes always opens round N+1 and
-- never mutates round N in place" expressed as a storage rule rather than as a
-- convention a future caller has to remember.

CREATE TABLE IF NOT EXISTS design_rounds (
  submission_id      TEXT NOT NULL,     -- the customer-visible SUB-XXXXXX reference
  round              INTEGER NOT NULL,  -- 1-indexed, monotonic per submission
  outcome_definition TEXT NOT NULL,     -- plain language, no engineer-side identifiers
  decomposition      TEXT NOT NULL,     -- JSON array of plain-language work items
  mock_bundle        TEXT,              -- absolute URL, or an R2 key under ARTIFACTS
  opened_at          TEXT NOT NULL,     -- when this round first appeared; never rewritten
  coord_revision     INTEGER NOT NULL,  -- the push that last revised it
  PRIMARY KEY (submission_id, round)
);

-- The customer's verdict, one row per decided round. There is deliberately no
-- `UPDATE` path in the application code: a verdict is a decision the customer
-- made at a point in time, and changing your mind opens a new round rather than
-- rewriting the record of the old one.
--
-- `comment` is NULL on approval — the contract pins `round-comment` as "present
-- only on rounds where changes were requested", so there is nothing to store.
CREATE TABLE IF NOT EXISTS signoffs (
  submission_id  TEXT NOT NULL,
  round          INTEGER NOT NULL,
  verdict        TEXT NOT NULL CHECK (verdict IN ('approved', 'changes-requested')),
  comment        TEXT,
  decided_at     TEXT NOT NULL,
  PRIMARY KEY (submission_id, round)
);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0006')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
