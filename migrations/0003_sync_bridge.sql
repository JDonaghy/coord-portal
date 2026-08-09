-- 0003_sync_bridge — the storage the outbound sync bridge (issue #15) needs.
--
-- Three facts, and nothing else:
--
--   bridge_events   the outbound stream the daemon pulls. Append-only.
--   coord_facts     the coord-owned mirror the daemon pushes, for facts this
--                   milestone has no column (and no screen) for yet.
--   bridge_daemon   one row: when the daemon was last heard from.
--
-- `submissions.coord_revision` is the per-submission idempotency watermark for
-- `POST /api/bridge/push`. NULL means "the daemon has never written to this
-- row", which is not the same as revision 0 — the daemon is free to start its
-- revisions wherever it likes and 0 is a legal first revision.
--
-- Nothing here is an inbound path. There is no table of registered callbacks,
-- no subscription, no daemon-supplied URL, and there must never be one — see
-- CLAUDE.md rule 2.

-- The outbound event stream.
--
-- `revision` is INTEGER PRIMARY KEY AUTOINCREMENT deliberately: AUTOINCREMENT
-- is what makes SQLite promise a rowid is never reused after a delete, which is
-- exactly the "monotonic and never reused" the wire contract pins. A plain
-- INTEGER PRIMARY KEY would recycle the highest id and silently hand the daemon
-- an event it has already seen at a revision it has already passed.
--
-- `payload` is stored, not recomputed at read time. Replay-safety means pulling
-- the same cursor twice returns the *same* events — a payload rendered from the
-- current row would quietly change under a daemon that replays after a later
-- edit.
--
-- `submission_id` holds the customer-visible `SUB-XXXXXX` reference, because
-- that is the identifier the wire contract uses on both `pull` and `push`. The
-- URL id (`sub_…`) is portal-internal and deliberately never crosses the wire.
CREATE TABLE IF NOT EXISTS bridge_events (
  revision       INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,
  submission_id  TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  payload        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bridge_events_submission
  ON bridge_events (submission_id);

-- The idempotency watermark for coord-owned writes. See src/bridge/updates.ts.
ALTER TABLE submissions ADD COLUMN coord_revision INTEGER;

-- Coord-owned facts this milestone does not model as columns yet
-- (`decomposition`, `question`, `design_round`, `artifacts`). The bridge must
-- not drop a write it acknowledged, and it must not invent a schema for screens
-- that do not exist (#10/#13 own those). So the value is kept verbatim as JSON
-- and handed to whichever issue renders it.
--
-- `value` is JSON text, so a string, a number, an array of work items and an
-- object all round-trip without this table having an opinion about which the
-- daemon will send.
CREATE TABLE IF NOT EXISTS coord_facts (
  submission_id  TEXT NOT NULL,
  field          TEXT NOT NULL,
  value          TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (submission_id, field)
);

-- Last-seen for the daemon. Exactly one row, enforced by the CHECK.
--
-- This is why `POST /api/bridge/heartbeat` exists: without it a dead daemon and
-- a slow one look identical from here, and the portal renders stale coord-owned
-- state as though it were current. `at` is what the daemon claimed;
-- `received_at` is when this Worker actually saw it — a daemon with a wrong
-- clock should not be able to make itself look fresh forever.
CREATE TABLE IF NOT EXISTS bridge_daemon (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  at           TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0003')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
