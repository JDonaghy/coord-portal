-- 0004_question_answers — the customer's half of issue #11's question channel
-- (raise -> pause -> resume).
--
-- `question` itself is a coord-owned fact and already has somewhere to live
-- (`coord_facts`, from 0003) — the daemon pushes it, keyed by
-- `(submission_id, field)`, and a later push simply overwrites the row with a
-- new `revision`. That is exactly right for "what is the current question",
-- but it cannot alone answer "has *this* question already been answered": the
-- coord-owned row has no memory of the portal's own write.
--
-- This table is that memory, and it is portal-owned (`answer` is a
-- portal-owned field per the sole-writer table — coord may never write it).
-- One row per question a customer has actually answered, keyed by the
-- `coord_facts.revision` the question carried at the moment of answering:
--
--   * A question is "open" (the pause composer renders) exactly when the
--     current `question` fact's revision has no matching row here.
--   * Answering inserts one row, tied to that revision, and does not touch
--     `submissions.status` — only the coordinator's own status push (#15)
--     ever moves that column, and it is not going to move it a second later
--     just because the portal decided the customer was done talking.
--   * A later question push carries a strictly higher revision (coord_facts
--     is keyed by field, so a new push replaces the row), which has no answer
--     row yet — the pause re-opens, exactly the "second question re-opens the
--     pause" behaviour issue #11 asks for. No answer is ever overwritten or
--     deleted; each revision keeps its own row, so an earlier answer stays
--     inspectable even after the thread moves on.
--
-- `INSERT ... WHERE NOT EXISTS` in the application code (see
-- src/routes/submission.ts) makes recording an answer idempotent against a
-- doubled form submit: the second attempt sees the row already there and
-- both no-ops the write and skips the `question.answered` event, rather than
-- telling the coordinator the same question was answered twice.
CREATE TABLE IF NOT EXISTS question_answers (
  submission_id     TEXT NOT NULL,
  question_revision INTEGER NOT NULL,
  answer            TEXT NOT NULL,
  answered_at       TEXT NOT NULL,
  PRIMARY KEY (submission_id, question_revision)
);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0004')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
