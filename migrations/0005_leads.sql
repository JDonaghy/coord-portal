-- 0005_leads — issue #31: the public lead form's own table.
--
-- A lead is deliberately NOT a submissions row with a flag: "leads is its own
-- table, not a submissions row with a flag ... it is what makes 'a stranger
-- cannot reach the pipeline' a structural fact rather than a policy someone
-- has to remember" (issue #31). This migration adds no foreign key toward
-- submissions and no column here is ever read by the sync bridge (CLAUDE.md
-- rule 2, and this milestone's own "coord never sees leads" invariant) — a
-- lead is inert: it creates no submission, enters no pipeline, and dispatches
-- nothing.
--
-- Promotion (turning a lead into a real submission, plus whatever bookkeeping
-- that needs — issue #33) is a deliberate operator act that is out of scope
-- for #31 and is not built here. This migration carries only what recording
-- one public lead needs today; a later migration is free to add promotion
-- columns without this one anticipating their shape.
--
-- `id` is the portal-minted slug — this milestone has no route that reads it
-- back by id (that is #33's operator surface). `reference` is the
-- customer-facing `LEAD-XXXXXX` shown on the receipt, kept separate from `id`
-- for the same reason `submissions.reference` is separate from
-- `submissions.id` (0002): the id is free to change shape later without
-- breaking a reference a stranger has already quoted back in an email.

CREATE TABLE IF NOT EXISTS leads (
  id            TEXT PRIMARY KEY,
  reference     TEXT NOT NULL UNIQUE,
  summary       TEXT NOT NULL,
  email         TEXT NOT NULL,
  name          TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0005')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
