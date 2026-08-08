-- 0001_init — the migration harness itself.
--
-- Deliberately does NOT create the portal's record model. Submissions, design
-- rounds, comments and sign-offs are #830, and the ownership rule they encode
-- (portal owns customer-authored facts, coord owns engineer-authored ones) is
-- the load-bearing decision there. This migration exists so that the mechanism
-- is proven and GET /api/health has something true to report.

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0001')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
