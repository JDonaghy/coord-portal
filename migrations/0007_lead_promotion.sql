-- 0007_lead_promotion — issue #33: what a lead records when an operator
-- promotes it.
--
-- 0005 deliberately carried only what recording a public lead needs ("a later
-- migration is free to add promotion columns without this one anticipating
-- their shape"). This is that migration.
--
-- Three columns, all NULL until an operator acts:
--
--   promoted_at                     when the operator promoted it (ISO-8601)
--   promoted_submission_id          the `sub_…` URL id of what it produced
--   promoted_submission_reference   the `SUB-XXXXXX` an operator can read out
--
-- `promoted_at IS NULL` is the whole lifecycle: NULL is `new`, non-NULL is
-- `promoted`. There is no `status` column, because a status column and a
-- promotion record are the same fact stored twice, and the day they disagree
-- there is no way to tell which one is right. There is also no `declined` or
-- `archived` state — issue #33 scopes those out, and "a lead nobody promotes
-- stays new forever" is a property of doing nothing, not a state to store.
--
-- **This is the idempotency key.** `POST /leads/:id/promote` claims the lead
-- with `... WHERE id = ? AND promoted_at IS NULL` inside the same D1 batch (one
-- transaction) that inserts the submission, so a double-click, a retry, or two
-- genuinely concurrent promotes converge on one submission: the second
-- transaction sees a non-NULL `promoted_at` and every statement in it no-ops.
-- Do not add a code path that writes these columns unguarded.
--
-- No foreign key to `submissions`, matching 0005's deliberate absence of one in
-- the other direction. The reference is the durable handle (0002: the id is
-- free to change shape later), and a lead must stay readable as a record of
-- first contact even if what it produced is later removed.
--
-- Nothing here is bridge-visible. "Coord never sees leads; they are
-- pre-pipeline by construction, and the sync bridge must not learn about them"
-- (issue #33) — promotion's only outbound trace is the ordinary
-- `submission.created` event that `POST /intake` already emits, byte-identical,
-- because it is emitted by the same code.

ALTER TABLE leads ADD COLUMN promoted_at TEXT;
ALTER TABLE leads ADD COLUMN promoted_submission_id TEXT;
ALTER TABLE leads ADD COLUMN promoted_submission_reference TEXT;

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0007')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
