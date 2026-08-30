-- 0020_inbound_emails — issue #161 (EM-1 of milestone #5): the inbound seam.
--
-- One row per message that reached the Worker's `email()` export. This table
-- is the *record of what arrived*, not a routing decision and not a reply:
-- #161 "routes nothing and replies to nothing — it records what arrived and
-- refuses what should never earn an answer." Every routing column below is
-- nullable and stays `NULL` until EM-3/EM-4/EM-5 fill it.
--
-- Entirely portal-owned (CLAUDE.md § Ownership). Nothing here ever crosses the
-- sync bridge: an inbound email is a customer-authored fact, and the epic's own
-- rule is that "coord never sees leads". There is no `bridge_events` row paired
-- with an insert here, exactly as `leads` has none.
--
-- ── to_email IS THE ENVELOPE RECIPIENT, NOT THE `To:` HEADER ────────────────
-- Load-bearing, and the single most likely thing to get quietly wrong. The
-- address a message was *delivered to* is what carries the plus-address token
-- (`intake+SUB-XXXXXX@…`) that EM-3's rung 1 resolves a thread from. The `To:`
-- MIME header is sender-controlled text that may name a list, a different
-- alias, or nothing at all — Cloudflare Email Routing hands the envelope
-- recipient to `email()` separately (`ForwardableEmailMessage.to`) precisely
-- because the two are not the same fact. `src/inboundEmail.ts` never reads the
-- `To:` header for this column, and `POST /__email` accepts the envelope
-- recipient out of band (a `?to=` query parameter) for the same reason.
--
-- ── NO FOREIGN KEYS ────────────────────────────────────────────────────────
-- Same as every other cross-table reference in this schema (0012's own
-- rationale, restated by 0014 and 0016): referential integrity lives in the
-- application code that writes both sides in one `DB.batch()`, not in a
-- constraint. `routed_lead_id`, `routed_project_id`, `routed_submission_id`,
-- `outbox_id` and `promoted_submission_id` are all plain `TEXT`.
--
-- ── disposition ────────────────────────────────────────────────────────────
-- `received`    — accepted; EM-3 onward may route it and draft a reply.
-- `suppressed`  — recorded, but it must never earn an answer (see
--                 `suppression_reason`). No draft, no routing, ever.
-- `rate_limited`— EM-9's cap. Recorded for the same reason `suppressed` is:
--                 "it just does not earn a reply … should not erase the
--                 evidence of itself." Not written by this issue; the value is
--                 in the CHECK now so EM-9 needs no second migration.
--
-- ── auth_result ────────────────────────────────────────────────────────────
-- The DMARC verdict, exactly one of `pass` / `fail` / `none`, parsed out of the
-- message's `Authentication-Results` header(s). WHICH HOP STAMPED IT MATTERS:
-- mail reaches this Worker via a Zoho forward, so the trustworthy verdict is
-- the one **Zoho** stamped for the *original* sender, not the one Cloudflare
-- stamped for the Zoho relay (forwarding routinely breaks SPF alignment, so
-- the Cloudflare-stamped hop can say `fail` about a perfectly legitimate
-- message). `src/inboundEmail.ts` therefore reads the *deepest* (earliest)
-- `Authentication-Results` header that carries a `dmarc=` token — see the
-- comment on `parseDmarcVerdict` there. `none` is the honest answer when no
-- hop stamped a DMARC verdict at all; EM-5 gates identity matching on `pass`.
--
-- ── body_text / body_truncated ─────────────────────────────────────────────
-- The stored body is capped (`MAX_BODY_TEXT_CHARS` in `src/inboundEmail.ts`).
-- An oversized message is still recorded — truncated and flagged, never
-- dropped silently (#161 scope item 6). `body_truncated` is `1` exactly when
-- the stored `body_text` is shorter than what arrived. Truncation does not
-- change `disposition`: a truncated message is processed like any other.
CREATE TABLE IF NOT EXISTS inbound_emails (
  id                 TEXT PRIMARY KEY,
  -- The sender's own `Message-ID` header, VERBATIM — angle brackets included,
  -- because `<…>` is part of RFC 5322's `msg-id` production and a value that
  -- does not match what the header said is a value nothing downstream can
  -- compare honestly. NULL when the message carried no `Message-ID` at all.
  -- Half of the redelivery guard below.
  message_id         TEXT,
  from_email         TEXT NOT NULL,
  from_name          TEXT,
  -- The ENVELOPE recipient. See the note above; this is not the `To:` header.
  to_email           TEXT NOT NULL,
  subject            TEXT NOT NULL,
  body_text          TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  auth_result        TEXT NOT NULL CHECK (auth_result IN ('pass', 'fail', 'none')),
  disposition        TEXT NOT NULL CHECK (disposition IN ('received', 'suppressed', 'rate_limited')),
  -- Why a non-`received` row was refused an answer, in a fixed slug vocabulary
  -- (`src/inboundEmail.ts`'s `SuppressionReason`). NULL for `received`.
  suppression_reason TEXT,
  attachment_count   INTEGER NOT NULL DEFAULT 0,
  body_truncated     INTEGER NOT NULL DEFAULT 0,

  -- ── Routing, all filled by later issues in this milestone ────────────────
  routed_kind            TEXT CHECK (routed_kind IS NULL OR routed_kind IN ('lead', 'message', 'unrouted')),
  routed_rung            INTEGER,
  routed_reason          TEXT,
  routed_runner_up       TEXT,
  routed_lead_id         TEXT,
  routed_project_id      TEXT,
  routed_submission_id   TEXT,
  outbox_id              TEXT,
  promoted_submission_id TEXT,
  promoted_at            TEXT
);

-- Redelivery must not double-record. A `Message-ID` is unique per message by
-- RFC 5322, so the same id arriving twice at the same envelope recipient is a
-- redelivery, not a second message — and the insert in `src/inboundEmail.ts`
-- uses `ON CONFLICT DO NOTHING` against this index, then reads the existing row
-- back, so a retry converges on one row instead of failing.
--
-- PARTIAL, "where `message_id` is present" (#161's own wording): a message with
-- no `Message-ID` at all has no identity to deduplicate on, and a plain
-- `UNIQUE (message_id, to_email)` would be no constraint on those rows anyway
-- (SQLite treats every NULL as distinct) while still costing a full index over
-- them. Scoping the index says that intent out loud.
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_emails_message_id
  ON inbound_emails (message_id, to_email)
  WHERE message_id IS NOT NULL;

-- Newest first, the only access pattern `/replies` (EM-6) ever needs. `id` is
-- the tiebreaker for two messages recorded in the same millisecond, the same
-- trick `messages` and `outbox` already use.
CREATE INDEX IF NOT EXISTS idx_inbound_emails_received_at
  ON inbound_emails (received_at DESC, id);

-- EM-3/EM-5 look a row up by what it routed to; EM-9 counts recent rows per
-- sender. Both are cheap to add now and awkward to add later.
CREATE INDEX IF NOT EXISTS idx_inbound_emails_from_email ON inbound_emails (from_email, received_at);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0020')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
