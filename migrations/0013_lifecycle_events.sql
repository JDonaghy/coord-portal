-- 0013_lifecycle_events — issue #111: the passive half of surfacing the
-- underlying dev lifecycle (a GitHub issue opening, a PR going up, tests
-- passing, a preview deploy becoming available) as read-only timeline detail.
--
-- ── WHY A NEW TABLE, GIVEN coord_facts ALREADY EXISTS ──────────────────────
-- `coord_facts` (0003) is keyed by `(submission_id, field)`, so a second push
-- of the same field *replaces* the first — exactly right for "what is coord's
-- current answer to the open question" and exactly wrong here: a customer
-- watching "PR opened" should still see "PR opened" once "Merged" lands, the
-- same reasoning `design_rounds` (0006) already gives for not reusing
-- `coord_facts` to hold a round. `lifecycle_events` is that table's shape,
-- applied to this fact instead: append-only, one row per event, nothing here
-- ever updated or deleted once written.
--
-- ── WHY IT IS KEYED (submission_id, revision) AND NOT AN AUTOINCREMENT id ──
-- The bridge push that carries a `lifecycle_event` field already comes with
-- its own idempotency token — `revision`, the same one `submissions.
-- coord_revision` and `design_rounds.coord_revision` key against — and a
-- daemon that retries a timed-out push must land the same event once, not
-- twice. Piggybacking on that token (`INSERT ... ON CONFLICT DO NOTHING`,
-- see `src/lifecycle.ts`) means a doubled push is a no-op without a second
-- lookup to decide it is one.
--
-- ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
-- No free-text `detail` column, no GitHub URL, no issue or PR number. Issue
-- #16's wall ("they never see a branch, an issue number, or a live agent")
-- applies here exactly as it does to a design round's decomposition: `kind`
-- is drawn from a closed, portal-owned vocabulary (`LIFECYCLE_EVENT_KINDS` in
-- `src/lifecycle.ts`) and rendered through portal-owned copy, never coord's
-- own words. `url` exists only because #107 gives the coordinator one link
-- that genuinely is customer-facing — the Cloudflare Pages preview build —
-- and `src/lifecycle.ts` accepts it only alongside `kind = 'preview-ready'`
-- and only when it is not itself a door back into the engineer's tracker.
CREATE TABLE IF NOT EXISTS lifecycle_events (
  submission_id  TEXT NOT NULL,     -- the customer-visible SUB-XXXXXX reference
  revision       INTEGER NOT NULL,  -- the bridge push that authored this event
  kind           TEXT NOT NULL,     -- closed vocabulary — see LIFECYCLE_EVENT_KINDS
  occurred_at    TEXT NOT NULL,     -- coord's own timestamp for the event, if it sent one
  url            TEXT,              -- only ever set for kind = 'preview-ready'
  created_at     TEXT NOT NULL,     -- when this portal recorded it
  PRIMARY KEY (submission_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_events_submission
  ON lifecycle_events (submission_id, occurred_at);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0013')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
