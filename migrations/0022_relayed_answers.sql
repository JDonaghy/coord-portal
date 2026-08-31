-- 0022_relayed_answers — issue #159: confirming an answer the operator
-- relayed on the customer's behalf.
--
-- `relayed_answer` itself needs no new table: it is a coord-owned fact
-- (`src/bridge/ownership.ts`), pushed and mirrored exactly like `question`
-- already is — one row per submission in `coord_facts` (0003), overwritten by
-- a later push, keyed by its own `coord_facts.revision`. See
-- `src/questions.ts`'s `getRelayedAnswer`.
--
-- What this migration adds is two columns on `question_answers` (0004) — the
-- table that already decides "is this question open" — never a parallel
-- table. A relay-confirmed answer *is* the customer's answer to that
-- question, the same row `getOpenQuestion` keys "open" against; a second
-- table would let "answered directly" and "answered via a confirmed relay"
-- disagree about whether a question is still open, which is exactly the
-- provenance drift issue #159 exists to close.
--
--   source                   'client' (default — a directly-typed answer, or
--                             a correction, see below) or 'relay_confirmed' —
--                             a customer's one-tap confirmation of the
--                             current `relayed_answer` fact.
--   relayed_answer_revision  the `coord_facts.revision` the confirmed
--                             `relayed_answer` carried, or NULL for a
--                             directly-typed answer. Lets a later push of a
--                             *different* relayed answer for the same
--                             still-open question tell apart from the one
--                             already confirmed — see `getQuestionScreenState`.
--
-- A relay-confirmed row is the one case this table's rows are ever updated in
-- place rather than only ever inserted once: "correcting supersedes rather
-- than erases" (issue #159's design sketch) describes the *coordinator's*
-- record, not this table. Both the original confirm and the correction still
-- reach the coordinator as their own `question.answered` bridge event
-- (`bridge_events` is append-only and never rewritten, per
-- `src/bridge/events.ts`) — this table only ever holds the *current* answer
-- for a revision, exactly as it already did before this migration.
ALTER TABLE question_answers ADD COLUMN source TEXT NOT NULL DEFAULT 'client';
ALTER TABLE question_answers ADD COLUMN relayed_answer_revision INTEGER;

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0022')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
