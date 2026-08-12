-- 0011_outbox_claim_lease — fix-round follow-up to issue #50's own "the thing
-- to get right": claiming must be safe against two *overlapping* invocations,
-- not just two invocations that happen to race on an identical stale read.
--
-- The `attempts` compare-and-swap `src/drain.ts` already had (`UPDATE outbox
-- SET attempts = attempts + 1 WHERE id = ? AND status = 'queued' AND
-- attempts = ?`) only protects two invocations that read the *same* stale
-- `attempts` snapshot. It does nothing for the staggered case a reviewer
-- traced concretely: invocation A wins the claim (attempts 0→1, `status`
-- still `queued` — this schema has no fourth "in-flight" status, by design,
-- see 0010's own comment) and starts `await provider.send(...)`; before A's
-- send resolves, invocation B's *own* fresh batch SELECT legitimately observes
-- `attempts = 1` (not stale — A really did move it there) and wins its own
-- CAS against that new value. Both invocations then call the real provider
-- for the same row before either terminal write lands — the DB write is
-- guarded, the external side effect (an actual email dispatch) is not.
--
-- `claimed_at` is the lease marker that closes that window. It is
-- deliberately NOT a fourth `status` value (0010's `CHECK` constraint is
-- unchanged, the Gate-A contract's "Delivery state vocabulary" pins exactly
-- three slugs) — it is an orthogonal column an invocation stamps with its own
-- claim time, so a row a *different* invocation is mid-send on is excluded
-- from the next invocation's candidate SELECT entirely, not merely lost at
-- the CAS after already having queued a provider call for it.
--
-- Nullable, no default beyond NULL: every existing `queued` row is
-- unclaimed, correctly, the moment this migration runs.
ALTER TABLE outbox ADD COLUMN claimed_at TEXT;

-- The drain's batch SELECT filters on `status = 'queued' AND (claimed_at IS
-- NULL OR claimed_at <= <lease threshold>)` every tick; an index on the pair
-- keeps that a cheap lookup rather than a full scan as `outbox` grows.
CREATE INDEX IF NOT EXISTS idx_outbox_status_claimed_at ON outbox (status, claimed_at);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0011')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
