-- 0002_submissions — the record model issue #8 carries forward, scoped to what
-- issue #9 (async intake) needs today.
--
-- A submission is a durable row from the moment the customer submits the
-- intake form, not session state: it must survive a reload and a redeploy.
-- `status` starts (and, in this milestone, stays) at 'describing' — the
-- transitions the rest of the vocabulary describes (In design, Awaiting your
-- sign-off, ...) belong to #13 and later, and are deliberately not modeled
-- here yet. Design rounds, comments and sign-offs are their own tables when
-- the issue that needs them lands, per the ownership rule in CLAUDE.md
-- ("portal owns customer-authored facts") — adding them now would be
-- building ahead of scope.
--
-- `id` is the portal-minted slug used in the URL (`/submissions/:id`).
-- `reference` is the customer-facing `SUB-XXXXXX` shown on screen. They are
-- deliberately separate: the id is free to change shape later without
-- breaking a reference a customer has already seen quoted back to them.

CREATE TABLE IF NOT EXISTS submissions (
  id               TEXT PRIMARY KEY,
  reference        TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'describing',
  customer_email   TEXT,
  outcome          TEXT NOT NULL,
  audience         TEXT NOT NULL,
  done_definition  TEXT NOT NULL,
  constraints      TEXT,
  project_scope    TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_customer_email ON submissions (customer_email);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0002')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
