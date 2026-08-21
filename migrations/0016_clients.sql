-- 0016_clients — issue #128: the row that represents "this customer," not any
-- one project or submission of theirs (epic #122).
--
-- Today `customer_email` is a bare string duplicated across `submissions` and
-- `projects` (0002, 0012) — there is no row anywhere a profile fact (phone,
-- cc emails, address) can hang off of, because there is no row for "the
-- customer" at all, only for the things they filed. This migration adds that
-- row and a nullable link from `projects` to it. It does not touch
-- `submissions` — the link is `submissions → projects → clients`, matching
-- how 0012 already routes a submission's project relationship.
--
-- `cc_emails` is a comma-separated TEXT column, not a join table — same
-- "revisit only if a real need shows up" posture the issue text takes.
--
-- ── NO BACKFILL ──────────────────────────────────────────────────────────
-- Every existing `projects` row keeps its bare `customer_email` string and
-- gets `client_id = NULL`. Retroactively inventing client records for
-- historical data is a separate decision — same posture 0012 already took for
-- `submissions.project_id`, and for the same reason: it is not this
-- migration's call to make silently. A project only ever gains a `client_id`
-- going forward, when lead promotion (#129) creates or matches a client.
--
-- ── NO FK CONSTRAINT ─────────────────────────────────────────────────────
-- Matches every other cross-table reference in this schema
-- (`leads.promoted_submission_id`, `design_rounds.submission_id`,
-- `submissions.project_id`) — referential integrity lives in the app code
-- that writes both sides inside one `DB.batch()`, not in a constraint. A real
-- FK here would make those batched two-sided writes order-dependent, and
-- would make deleting a client fail rather than orphan.
--
-- ── NO UI ────────────────────────────────────────────────────────────────
-- Schema only. Lead promotion linking, project reassignment and the client
-- profile page are the other issues under epic #122 that build on this.

CREATE TABLE IF NOT EXISTS clients (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  phone      TEXT,
  cc_emails  TEXT,   -- comma-separated; revisit as a join table only if a real need shows up
  address    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients (email);

ALTER TABLE projects ADD COLUMN client_id TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_client_id ON projects (client_id);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0016')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
