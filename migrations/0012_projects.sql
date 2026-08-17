-- 0012_projects — issue #109: the entity above `submissions` that a customer
-- relationship, not a single round of work, actually belongs to.
--
-- Before this migration the only thing linking two submissions from the same
-- customer was a bare string match on `customer_email`
-- (`idx_submissions_customer_email`) — every submission was a fully
-- independent row, so a customer with an ongoing relationship (round 1
-- shipped, round 2 about to start) showed up as two unrelated cards on
-- `/submissions` with no way to see them as one thing.
--
-- `projects` is deliberately thin: an id, the customer relationship it
-- belongs to, and when it started. No status, no title column — a project has
-- no state of its own to store; everything it shows is derived from the
-- submissions under it (see `src/projects.ts`), the same way a submission's
-- customer-visible status is derived rather than duplicated (`src/rounds.ts`).
--
-- `submissions.project_id` is nullable and starts NULL for every row,
-- including every row this migration runs against — issue #109 is explicit
-- that retroactively assigning existing submissions to invented projects is
-- a separate decision, not part of this migration. A submission only ever
-- gains a `project_id` going forward, when the customer explicitly files a
-- follow-up from an existing submission's own detail screen (see
-- `NewSubmissionInput.followUpFrom` in `src/submissions.ts`) — never by a
-- background job, and never merely by two submissions sharing a
-- `customer_email`. That second point is not a simplification: the sealed
-- acceptance suite already pins that two submissions one customer files
-- independently through `/intake` render as two separate rows on
-- `/submissions` (`tests/acceptance/ms-1/12-access-auth.spec.ts`, "the
-- dashboard lists only the caller's own submissions"), so inferring a shared
-- project from a matching email alone would silently merge two unrelated asks
-- and break that contract.
--
-- No `FOREIGN KEY` — matching every other cross-table reference in this
-- schema (`leads.promoted_submission_id`, `design_rounds.submission_id`):
-- this codebase keeps referential integrity in the application code that
-- writes both sides inside one `DB.batch()` transaction, not in a constraint.

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  customer_email TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_customer_email ON projects (customer_email);

ALTER TABLE submissions ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_submissions_project_id ON submissions (project_id);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0012')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
