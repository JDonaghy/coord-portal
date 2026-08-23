-- 0019_client_merge — issue #150: "two addresses, one person" — an operator's
-- only recourse today, on finding `johnfdonaghy@gmail.com` and
-- `johnfdonaghy@outlook.com` are the same customer with a project each, is to
-- edit D1 by hand. `clients.email` is `NOT NULL UNIQUE` (0016) — the address
-- *is* the row's identity — so there was never a way to say "these two rows
-- are one relationship" without breaking that.
--
-- This is operator-side grouping ONLY (#150's own scoping). It does not touch
-- `submissions.customer_email` or `projects.customer_email`, and it does not
-- widen `isOwnedBy` (`src/routes/submission.ts`) — a merged client still
-- signs in as two separate Cloudflare Access identities, and rewriting either
-- column would silently lock a customer out of whatever they filed under the
-- address that stopped being the row's `email`.
--
-- ── merged_into / merged_at ─────────────────────────────────────────────────
-- `merged_into` names the surviving `clients.id` a row was folded into, or
-- `NULL` for a row that was never merged away (every row before this
-- migration, and most rows after it). `merged_at` is the companion timestamp.
-- Both exist purely so a merge is visible after the fact — "an operator
-- should be able to tell a merged client from one that was always a single
-- row" (#150) — and so `mergeClients` (`src/clients.ts`) has something to
-- guard idempotency on: a retried or doubled merge request must not re-append
-- an address or re-run the project repoint.
--
-- No FK, matching every other cross-table (and, here, same-table) reference
-- in this schema (see 0016's own note) — referential integrity is the app
-- code's job, not a constraint's.
ALTER TABLE clients ADD COLUMN merged_into TEXT;
ALTER TABLE clients ADD COLUMN merged_at TEXT;
CREATE INDEX IF NOT EXISTS idx_clients_merged_into ON clients (merged_into);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0019')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
