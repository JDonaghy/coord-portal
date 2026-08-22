-- 0017_start_work — issue #132: the operator "start work" override.
--
-- "The operator already agreed the work out-of-band ... running a design
-- round would only add latency for no benefit — this is an override, not a
-- fast-tracked design round." The override skips the whole
-- Describing -> In design -> Awaiting sign-off -> Signed off loop and lands
-- the submission on the customer-visible equivalent of Planned, the instant
-- the operator acts.
--
-- ── ONE ROW, ONE ONE-WAY DECISION ───────────────────────────────────────────
-- Unlike `design_rounds`/`signoffs` (0006) or `preview_reviews` (0015), there
-- is nothing versioned here: an operator "starts work" on a submission at
-- most once, ever, and there is no round number or preview URL to key a
-- second row by. One row per submission is the whole shape.
--
-- ── WHY THIS IS PORTAL-OWNED, AND WHY IT NEVER TOUCHES submissions.status ──
-- `status` is coord-owned (`src/bridge/ownership.ts`) — there is no portal
-- code path that writes it, and this migration does not create one. Recording
-- the operator's decision here and *deriving* a customer-visible `planned`
-- from it (`derivedStartWorkStatus`, `src/startWork.ts`) is the same trick
-- `derivedStatus` (0006/src/rounds.ts) already plays for an approved design
-- round, and `derivedQualityCheckStatus` (0015/src/previewReviews.ts) plays
-- for a preview review: a portal-owned fact plus the stored coord status
-- produces the screen, without ever writing over the column the coordinator
-- owns.
--
-- ── THE BRIDGE EVENT DECISION (issue #132's "one real design decision") ────
-- Issue #132 asks for a pick between reusing `signoff.approved`'s shape or
-- adding a new `work.requested` bridge event kind, and to document the
-- choice. `src/startWork.ts`'s `recordStartWork` reuses `signoff.approved` —
-- see that module's doc comment for the full reasoning. This table carries no
-- verdict or comment column of its own for that reason: there is nothing
-- customer-authored to record beyond the fact and the moment it happened, and
-- the event this drives already carries the pinned `signoff.approved` shape
-- with a marker distinguishing an operator override from a genuine customer
-- decision.
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────────────
-- `submission_id` is the primary key, so a second `INSERT OR IGNORE` (a
-- retried POST, a double-click, two concurrent requests) is a true no-op —
-- exactly the guarantee `promoted_at IS NULL` gives `leads` (0007), just
-- without a companion column to guard: the row's mere existence *is* the
-- guard. `src/startWork.ts`'s `recordStartWork` pairs this insert with the
-- bridge event in the same `DB.batch()`, guarded by the identical
-- `WHERE NOT EXISTS` shape `recordSignoff`/`recordPreviewReview` already use,
-- so the event can never be emitted without the fact landing, or vice versa —
-- the same ordering guarantee already in place for `awaiting-signoff`'s
-- design-round push and `quality-check`'s preview push, applied here to a
-- one-time operator action instead of a coordinator push.
CREATE TABLE IF NOT EXISTS start_work (
  submission_id  TEXT PRIMARY KEY,  -- the customer-visible SUB-XXXXXX reference
  started_at     TEXT NOT NULL
);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0017')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
