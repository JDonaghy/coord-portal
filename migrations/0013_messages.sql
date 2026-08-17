-- 0013_messages — issue #110: async chat/threaded comments.
--
-- Before this migration the only customer-authored free text anywhere in the
-- schema was a single `signoffs.comment` (captured only on "changes
-- requested") and a single `question_answers.answer` (one answer per
-- coord-raised question) — no threading, no follow-up, no way to ask a
-- clarifying question before deciding, nothing resembling a message log
-- either side could review later.
--
-- `messages` is deliberately thin and append-only, the same shape
-- `question_answers` and `signoffs` already use for a portal-owned,
-- never-edited, never-deleted per-submission log: one row per message, in the
-- order it was sent, with no `UPDATE` or `DELETE` path in the application
-- code. A conversation is a record of what was actually said, not a document
-- either party gets to revise after the fact.
--
-- ── SUBMISSION-SCOPED, NOT PROJECT-SCOPED ───────────────────────────────────
-- Issue #110's own scope note: "submission-scoped at minimum, project-scoped
-- once the project entity exists — this should land on top of that if the
-- ordering allows, but can ship submission-scoped as an interim step if not."
-- Issue #109 (the `projects` table, `migrations/0012_projects.sql`) has
-- landed, but a project-level thread is a genuinely separate design question
-- (which submission does a message posted from `/projects/:id` belong to, if
-- any?) that #109 does not answer and this migration does not try to. Shipping
-- submission-scoped now, per the explicitly-sanctioned interim path, rather
-- than guessing at a project-level shape nobody has specified yet.
--
-- `submission_id` stores the customer-visible `SUB-XXXXXX` reference, not the
-- `sub_…` row id — the same key every other portal-owned per-submission table
-- in this schema uses (`design_rounds`, `signoffs`, `question_answers`), and
-- for the same reason: the reference is the stable cross-system identity a
-- bridge event or a support conversation would quote back, not an internal
-- URL slug.
--
-- ── WHY THERE IS NO bridge_events ROW HERE ──────────────────────────────────
-- `question_answers` and `signoffs` both pair their insert with a
-- `bridge_events` row (`question.answered`, `signoff.approved` /
-- `signoff.changes_requested`) so the coordinator's poll picks up the
-- customer's decision. Messages deliberately do NOT: `src/bridge/events.ts`
-- states plainly that `BRIDGE_EVENT_TYPES` "is closed here anyway because it
-- is the half of the contract #15 owns, and #1982 is building against it
-- today" — widening that pinned vocabulary from this issue would risk
-- colliding with a contract another workstream is actively building against,
-- for a fact the coordinator's daemon has no stated need to see (an
-- operator, not the coord daemon, is the other party in this thread — see
-- `src/messages.ts` and `src/routes/submission.ts`). A future issue that
-- wants the coordinator to observe messages is where that vocabulary change
-- belongs, made deliberately and in coordination with #1982, not folded
-- silently into this one.
--
-- ── author_role, NOT A FOREIGN KEY TO submissions OR operators ─────────────
-- `author_role` is `'customer'` or `'operator'` — the same two identities
-- `src/operators.ts` already distinguishes for every other authenticated
-- write in this codebase. No `FOREIGN KEY`, matching every other cross-table
-- reference in this schema (`design_rounds.submission_id`,
-- `leads.promoted_submission_id`): referential integrity lives in the
-- application code that writes it, not in a constraint.
CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  submission_id  TEXT NOT NULL,     -- the customer-visible SUB-XXXXXX reference
  author_role    TEXT NOT NULL CHECK (author_role IN ('customer', 'operator')),
  author_email   TEXT NOT NULL,
  body           TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- Ordered-by-time is the only access pattern this thread ever needs
-- (`src/messages.ts`'s `listMessages`) — oldest first, per submission. `id` is
-- the tiebreaker for two messages minted in the same millisecond, the same
-- trick `outbox` and `bridge_events` already rely on their own primary key for.
CREATE INDEX IF NOT EXISTS idx_messages_submission_id ON messages (submission_id, created_at, id);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0013')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
