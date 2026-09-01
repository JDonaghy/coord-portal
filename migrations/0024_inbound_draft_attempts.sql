-- 0024_inbound_draft_attempts — issue #169 (EM-9 of milestone #5): the abuse
-- control a mailbox needs and `POST /start` already has.
--
-- `POST /start` is defended by Turnstile, a coarse per-IP rate limit
-- (`start_attempts`, 0008) and a refusal banner that never confesses which
-- check it tripped. A mailbox has none of that and cannot have Turnstile —
-- Cloudflare Email Routing hands a message to `email()` however fast an
-- attacker can send it. This table is `start_attempts`'s own precedent,
-- reused rather than reinvented: one row per draft attempt, a sliding window
-- over `at`, no reset seam to time a burst around. See `src/rateLimit.ts`'s
-- `isInboundDraftRateLimited` for the check this storage backs.
--
-- ── WHY `from_email`, NOT AN IP ─────────────────────────────────────────────
-- Cloudflare Email Routing gives `email()` no client IP at all — there is no
-- TCP connection here for a Worker to see, only a parsed message. The address
-- an attacker controls least cheaply is the one the sender claims to be, so
-- that is what this table buckets on, exactly the way `start_attempts`
-- buckets on `clientIp()`'s best answer for its own transport.
--
-- ── WHY ONE TABLE SERVES BOTH THE PER-SENDER AND THE TOTAL CAP ──────────────
-- EM-9's own text: "Cap drafts created, per sender and in total." A row per
-- attempt, irrespective of sender, is a total count with `COUNT(*) WHERE
-- at >= ?` and a per-sender count with the same query plus `AND from_email =
-- ?` — no second table, no second window to keep in sync with the first.
--
-- ── WHAT COUNTS AS AN "ATTEMPT" HERE ─────────────────────────────────────────
-- Only a message that reached the point of earning a draft at all —
-- `src/inboundEmail.ts` checks this budget after `detectSuppression`, not
-- before. A `suppressed` message (an auto-responder, a bounce, a mailing
-- list) was never going to draft anything regardless of this cap, so it does
-- not spend it — unlike `start_attempts`, where every attempt costs a
-- `siteverify` call this table's own reasoning does not apply to an inbound
-- message at all.
--
-- No foreign key toward `inbound_emails` — same reasoning 0008 gives for
-- `start_attempts` toward `leads`: an attempt is recorded whether or not the
-- message it belongs to turns out to be a duplicate delivery.
CREATE TABLE IF NOT EXISTS inbound_draft_attempts (
  from_email TEXT NOT NULL,
  at         TEXT NOT NULL
);

-- Every per-sender query filters by `from_email` first, then `at`. The total
-- cap's own query (`at >= ?`, no `from_email` predicate) still benefits from
-- an index with `at` in it, so this one index serves both shapes rather than
-- needing a second.
CREATE INDEX IF NOT EXISTS idx_inbound_draft_attempts_from_email_at
  ON inbound_draft_attempts (from_email, at);
CREATE INDEX IF NOT EXISTS idx_inbound_draft_attempts_at
  ON inbound_draft_attempts (at);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0024')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
