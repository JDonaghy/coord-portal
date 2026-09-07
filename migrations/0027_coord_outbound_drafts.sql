-- 0027_coord_outbound_drafts — issue #318: review, edit and approve coord's
-- queued outbound drafts in the portal, not only from a terminal.
--
-- ── THE PROBLEM THIS TABLE SOLVES ───────────────────────────────────────────
-- Every coord-owned push (`design_round`, `question`, `relayed_answer`,
-- `status`, `preview`) is staged in coord's own `portal_outbox` before it is
-- sent — a draft a human releases with `coord portal draft approve`. That
-- table lives in coord's own SQLite; this portal cannot read it, and until
-- this migration had no representation of "something is queued, unreleased"
-- at all. An operator reviewing a submission here had no way to see, let
-- alone act on, the very message that submission was waiting on.
--
-- This table is the portal's own mirror of that queue — not a copy of
-- `portal_outbox` itself (a different database, a different schema, coord's
-- own concern), but the minimum an operator's screen needs: which submission,
-- what kind, the editable text as queued, and when. Coord asserts this
-- mirror's contents on every poll tick (`POST /api/bridge/outbound-drafts`,
-- `src/routes/bridge.ts`); this side never invents a row coord did not tell
-- it about.
--
-- ── WHY A NEW TABLE, NOT `coord_facts` ──────────────────────────────────────
-- `coord_facts` (0003) is the last-value mirror of a fact coord has already
-- decided and pushed as true — `design_round`/`question`/`relayed_answer`
-- pushed through `POST /api/bridge/push` land there because the customer is
-- meant to see them immediately. A pending draft is the opposite: it is
-- explicitly *not yet* true, and must not render anywhere a customer can see
-- until an operator releases it. Folding "queued, unreleased" into the same
-- table `applyUpdates` (`src/bridge/updates.ts`) treats as "already true"
-- would mean threading a new pending/applied distinction through every
-- reader of `coord_facts` — this is the same "a new axis is not a new value
-- of an existing column" reasoning `migrations/0021_outbox_approval.sql`
-- gives for `outbox.approval_state`, applied to coord's own facts instead of
-- the portal's replies.
--
-- ── THE COLUMNS ──────────────────────────────────────────────────────────────
--   id             coord's own `portal_outbox` row id — the wire identity
--                  both directions key off. Never minted here.
--   submission_id  the customer-visible SUB-XXXXXX reference, the same wire
--                  identity every other bridge table uses (see 0003's own
--                  note on `bridge_events.submission_id`).
--   kind           which of the five coord-owned push shapes this is.
--   fields         JSON object of the editable text field(s) as coord queued
--                  them — `outcome_definition` for a `design_round`, the
--                  question text for a `question`, and so on. Stored
--                  verbatim, the same "acknowledge and keep it, never
--                  silently reshape it" posture `coord_facts.value` already
--                  takes for a coord-owned field this schema has no column
--                  for.
--   queued_at      when coord queued it — coord's own clock, not this
--                  table's write time, so "how long has this been waiting"
--                  reads true even if the mirror lags a tick behind.
--   state          'pending' | 'approved' | 'rejected'. An operator's
--                  decision is terminal here — see `src/coordOutboundDrafts.ts`
--                  — the same one-way `approval_state` already takes on
--                  `outbox` (0021).
--   decided_at / decided_by
--                  set together the moment `state` leaves `pending`, the same
--                  pairing `outbox.approved_at`/`approved_by` already
--                  establishes.
--   edited_fields  JSON object of what the operator actually approved, which
--                  may differ from `fields` — present only once `state` is
--                  `approved`. This, not `fields`, is what
--                  `outbound_draft.approved` (`src/bridge/events.ts`) carries
--                  back to coord: "apply *this* text to the row before
--                  sending," per issue #318's own wire-contract framing.
--
-- ── THE UPSERT GUARD ─────────────────────────────────────────────────────────
-- `src/coordOutboundDrafts.ts`'s push-side write is an
-- `ON CONFLICT(id) DO UPDATE ... WHERE state = 'pending'` — a re-assertion of
-- an already-decided row's `fields`/`queued_at` is a no-op, not a rewrite.
-- Coord polls this portal on its own tick and may re-push the same still-open
-- draft many times before an operator acts on it; once they have, a later
-- push racing behind that verdict must never resurrect it back to `pending`.
--
-- ── WHAT THIS MIGRATION DOES NOT ADD ─────────────────────────────────────────
-- No column recording that coord has since withdrawn a draft (released it
-- itself via the terminal, or discarded it) — coord simply stops asserting
-- that id on a future push. A row already decided here is unaffected either
-- way, and a row still `pending` here after coord stopped asserting it is a
-- known gap, flagged rather than silently worked around: closing it needs the
-- wire contract to say what "withdrawn" looks like, which is exactly the kind
-- of shape the code-coordinator companion issue this issue asks for should
-- settle, not a guess made unilaterally on this side.
CREATE TABLE IF NOT EXISTS coord_outbound_drafts (
  id             TEXT PRIMARY KEY,
  submission_id  TEXT NOT NULL,
  kind           TEXT NOT NULL
    CHECK (kind IN ('design_round', 'question', 'relayed_answer', 'status', 'preview')),
  fields         TEXT NOT NULL,
  queued_at      TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected')),
  decided_at     TEXT,
  decided_by     TEXT,
  edited_fields  TEXT
);

CREATE INDEX IF NOT EXISTS idx_coord_outbound_drafts_submission
  ON coord_outbound_drafts (submission_id, state);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0027')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
