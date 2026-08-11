# ms-3 — Email actually reaches the customer (Resend, provider-only) — Gate-A contract

Written by an independent mock-author agent from milestone tracking issue **#53** and the 5 open
issues filed under it (#49, #50, #51, #52, #55), before and without sight of any implementation.
This is the black-box surface: exact route paths, screen text, `data-testid` hooks, status
vocabulary, and (because this milestone's real surface is mostly a state machine, not new screens)
config-var names and a deterministic test-fake hook, that the milestone's workers and the
independent `test-author` agent must agree on without a shared session. Mocks are self-contained
HTML under `mocks/`, one file per screen state, styled against the real `public/tokens.css` — same
convention `ms-1/contract.md` and `ms-2/contract.md` established.

**Amendment (this pass):** issue #55 was filed after this contract's initial authoring, against
this contract's own Notes item 3 (quoted there verbatim in #55's own body) — the original text
declined to invent an operator-wide delivery view because no issue asked for one. #55 is that
issue. This amendment adds `mocks/05-deliveries-mixed.html`, `mocks/06-deliveries-empty.html`, and
the "The operator delivery view (issue #55)" section below; everything else in this file is
unchanged from the original Gate A pass.

Driver: `web-playwright`. Medium: static HTML, no build step, no framework, no live data.

Design of record: `docs/CUSTOMER_PORTAL.md` in `claude-coordinator`, § "Notifications: email,
digest-first". This milestone sits on top of **ms-1** (issue #14 shipped the `outbox` table and
`GET /outbox`, read-only, undelivered) — nothing here reopens ms-1's screens; this contract only
extends the one route #14 already pinned loosely and #49 now pins exactly.

**This milestone is provider-only, deliberately.** Per #53's own framing, "nothing in this repo can
observe a real inbox" — so unlike ms-1 and ms-2, most of what this contract pins is not new pixels
but a state machine (`outbox.status`) and a deterministic seam into the mail provider (the #51
fake), because that is the actual black-box surface #53 states exists to gate. Read the "Delivery
state machine" and "The provider seam" sections as carrying the same authority as the mocks — they
are not incidental implementation notes.

## Mock inventory (`mocks/`)

| File | Screen state | Route it represents |
|---|---|---|
| `01-outbox-queued.html` | One row, `queued` — decided, not yet claimed by the drain | `GET /outbox` |
| `02-outbox-sent.html` | One row, `sent` — delivered, with a delivery timestamp | `GET /outbox` |
| `03-outbox-failed.html` | One row, `failed` — gave up after N attempts, customer-safe error copy | `GET /outbox` |
| `04-outbox-mixed.html` | Three rows, one of each state — the realistic screen | `GET /outbox` |
| `05-deliveries-mixed.html` | Operator view, three rows across three different customers, one of each delivery state — the realistic screen | `GET /deliveries` |
| `06-deliveries-empty.html` | Operator view, no outbox rows exist anywhere | `GET /deliveries` |

Mocks 01–04 are all the same route; only the row data differs, the same "one template, several
`data-status` values" convention `ms-1/contract.md` used for its four rollup states. There is no
mock for a `queued` row that has already failed one or more attempts and is awaiting retry
(`attempts > 0`, `status` still `queued`) — see "Delivery state vocabulary" below: it renders
**identically** to `01-outbox-queued.html`, on purpose, so a fifth near-duplicate mock would add
nothing a comment couldn't. Mocks 05–06 are likewise both `GET /deliveries` — see "The operator
delivery view (issue #55)" below.

No mock exists for #50 (the cron drain) or #52 (domain auth/reply routing) individually — #50 has
no screen, only the state transitions the four `/outbox` mocks above already show the endpoints of;
#52 is `oracle:exempt` operator configuration with no code surface at all (per #53's own text,
quoted below).

## Route surface (pinned)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/outbox` | customer (scoped to caller's own `to_email`, unchanged from ms-1) | now renders delivery state per row, in addition to the ms-1 email content |
| `GET` | `/deliveries` | operator (`readOperator` allowlist, same as `/leads` — see "The operator delivery view (issue #55)") | every outbox row, every customer, most recent activity first |
| `GET` | `/__scheduled` | **local dev / acceptance only, never in production** | invokes the Worker's `scheduled()` export directly — the only way the sealed suite can drive #50's cron drain. See "Triggering the drain in the sealed suite" below. |

No other route is pinned. #51's `MailProvider` interface and #51's fake are code-level seams, not
HTTP surface — see "The provider seam".

## Delivery state vocabulary (pinned, from issue #49)

`outbox` gains a `status` column. Fixed set, `data-status` slug → exact pill text on
`delivery-status`:

| slug | pill text | meaning |
|---|---|---|
| `queued` | Queued | decided, not yet delivered — fresh (`attempts = 0`) or mid-retry (`attempts > 0`), indistinguishable to the customer |
| `sent` | Sent | delivered; the provider accepted it |
| `failed` | Delivery failed | every retry exhausted; terminal, and per #50 "visible" |

Existing rows migrate to `queued` (#49's own words). A row's `status` only ever moves
`queued → sent` or `queued → failed`; there is no path back out of either terminal state and no
manual retry surface anywhere in this milestone's scope (see Notes, item 3, on the "operator has no
way to see a stuck notification" gap).

**A `queued` row renders identically regardless of `attempts`.** This is this contract's own
resolution of an underspecified point (#50 does not say what a mid-retry row looks like): a retry
in progress conveys nothing actionable to a customer and would only read as alarming flicker across
polls. `delivery-attempts` and `delivery-last-error` render **only** on `failed` rows.

## `data-testid` hooks (pinned — extends ms-1's "Emails" block)

Every `email-preview` article (ms-1's hooks — `data-email-type`, `email-from`, `email-to`,
`email-subject`, `email-preheader`, `email-body`, `email-cta` — unchanged, still all present on
every row regardless of delivery status; ms-1's own sealed suite,
`tests/acceptance/ms-1/14-notifications.spec.ts`, already polls `/outbox` and counts
`email-preview` elements the instant a send is *decided*, before any delivery attempt — that
must keep working unmodified) now additionally carries `data-status` set to one of the three slugs
above, and contains:

- `delivery-status` — the pill. `data-status` ∈ `queued` / `sent` / `failed`; text exactly
  `Queued` / `Sent` / `Delivery failed`. Always present.
- `delivery-sent-at` — present **if and only if** `data-status="sent"`. Non-empty, human-readable
  text. Exact format not pinned (illustrative in the mocks, same convention as timestamps
  elsewhere in this repo's mocks) — a test may assert presence and non-emptiness, not a specific
  string or date format.
- `delivery-attempts` — present **if and only if** `data-status="failed"`. Must contain at least
  one base-10 integer (the attempt count). Exact wording not pinned; `mocks/03` and `04` use "We
  tried 5 times" as illustrative copy only.
- `delivery-last-error` — present **if and only if** `data-status="failed"`. Customer-safe,
  generic copy — see "Customer-safe error copy" below. Exact wording not pinned.
- `delivery-provider-id` — **not part of this contract.** `outbox.provider_message_id` is recorded
  durably (#49 commits to the column existing) but this contract deliberately does not require it
  on the customer-scoped `/outbox` page — see "Why provider-message-id is not on the customer page"
  in Notes. A worker who renders it anyway with this `data-testid` is additive, not a violation; no
  test in this milestone should require it.

## Customer-safe error copy (pinned invariant)

`GET /outbox` is the same customer-scoped route ms-1 built (`to_email = caller's Access identity`).
`delivery-last-error`'s rendered text is **not** `outbox.last_error` verbatim — the DB column holds
whatever the provider or an unset key produced ("Resend API returned 401", "RESEND_API_KEY unset",
a fetch failure message), which is operator-debugging material, not customer copy. A test may assert
that `delivery-last-error`'s text contains none of:

- ms-1's existing FORBIDDEN list (`tests/acceptance/ms-1/14-notifications.spec.ts`'s `FORBIDDEN`
  array: issue numbers, "branch", "commit", "worktree", "agent", "worker", "github", "daemon",
  etc.) — unchanged, still applies to every customer-facing string this milestone adds, and
- infra/provider vocabulary this contract adds to that list for this field specifically: `resend`
  (case-insensitive), `api key`, `fetch`, any bare 3-digit HTTP status code (`\b\d{3}\b`), `provider`,
  `endpoint`.

`mocks/03-outbox-failed.html` and `04-outbox-mixed.html` use "We couldn't deliver this message and
have stopped trying. You can still check your request below." as illustrative, non-pinned copy that
satisfies this.

## The operator delivery view (issue #55 — pinned)

`GET /deliveries` — the operator's counterpart to `/outbox`: every `outbox` row across every
customer, not scoped to a single `to_email`, most recent activity first. It exists because #49's
own motivating line ("the operator has no way to see a stuck notification") was never actually
closed by #49/#50/#51 — the original pass of this contract said so explicitly (Notes item 3,
below) and declined to invent a route no issue had asked for. #55 is that issue, filed against this
contract's own gap.

**Route name.** #55's own text calls `/deliveries` "a proposal, not a requirement." This contract
resolves that open question by pinning `/deliveries` as the exact path — a contract has to name
something concrete for the test-author to write against, and `/deliveries` is #55's own suggestion
and does not collide with any existing route. If a worker ships a different path, that is a contract
amendment, not a free choice — say so in the PR the same way #50's implementer must say so about
the retry count below.

**Auth — reuses the `/leads` precedent exactly, per #55's own text ("This is not new auth").** No
second mechanism is invented:

- Same `readOperator(request, env)` gate `src/routes/leads.ts` already uses (`src/operators.ts`'s
  `OPERATOR_EMAILS`/`OPERATOR_EMAIL` allowlist, `DEV_OPERATOR_EMAIL` fallback off the Cloudflare
  edge).
- **No Access identity, or an identity not on the allowlist, gets the same 404** `leadsNotFound()`
  already renders for `/leads` — never a login redirect, never a 403 that confirms `/deliveries`
  exists. A synthetic customer identity (owns rows in `outbox`, is not the configured operator)
  must be rejected identically to an anonymous caller — same invariant `ms-2/contract.md`'s
  "Operator access" section pins for `/leads`, extended here without restatement.
- This is **distinct** from the empty-list state: zero `outbox` rows anywhere is a 200 with
  `deliveries-list-empty` (see below); not being an operator is always a 404, regardless of how
  much or little data exists. A test must not conflate the two.

**Operator nav.** `operatorTopbar()` (`src/render.ts`) currently hardcodes a single nav entry,
`nav-leads`, with `aria-current="page"` fixed rather than computed from the current route — the
same page every screen behind it renders. This milestone's mocks pin that it gains a second entry,
`nav-deliveries`, and that `aria-current="page"` becomes conditional on which of the two is
current — the same pattern the customer-facing `topbar()` already uses for `nav-dashboard` /
`nav-new` / `nav-outbox`. Both mocks below show `/deliveries` current; a `/leads` mock from ms-2
showing `/deliveries` present-but-not-current would also be consistent with this contract, though
none is re-rendered here since ms-2's mocks are that milestone's own artifacts, not this one's to
amend.

**Row surface.** Per #55's Scope section verbatim: "showing the delivery state #49 adds (`status`,
`attempts`, `last_error`, `sent_at`) alongside the recipient address and subject." Deliberately
**not** the full `email-preview` DOM `/outbox` renders (no `email-body`, no `email-preheader`, no
`email-cta`) — an operator triaging a stuck send needs enough to identify and diagnose the row, not
a rendered copy of the marketing/transactional content, and #55's own Scope list stops at subject.
New `data-testid` hooks, one `delivery-row` per outbox row:

- `deliveries-list` — the container. `deliveries-list-empty` — present instead, if and only if
  there are zero `outbox` rows across every customer (paragraph text, exact wording not pinned).
- `delivery-row` — one per row, carries `data-status` ∈ `queued` / `sent` / `failed`, same three
  slugs "Delivery state vocabulary" pins for `/outbox`.
- `delivery-recipient` — the row's `to_email`, verbatim, unredacted. Unlike the customer-scoped
  `/outbox`, there is no "whose data is this" boundary to protect here — the operator can already
  see every customer's leads and submissions (#33), and a delivery view that hid *who* a stuck
  email was addressed to would defeat the point of the screen.
- `delivery-subject` — the row's subject line, verbatim.
- `delivery-status` — the pill, same three slugs and exact text (`Queued` / `Sent` /
  `Delivery failed`) as `/outbox`'s `delivery-status`. Always present.
- `delivery-sent-at` — present iff `data-status="sent"`, same presence rule as `/outbox`.
- `delivery-attempts` — present iff `data-status="failed"`, same presence rule as `/outbox`. Exact
  wording not pinned; `05-deliveries-mixed.html` uses "5 attempts" as illustrative copy only (a
  test may assert an integer appears, not this exact string).
- `delivery-last-error` — present iff `data-status="failed"`. **This is the pinned point of
  divergence from `/outbox`: this text is the raw `outbox.last_error` column, unredacted.** The
  "Customer-safe error copy" section above governs the *customer*-scoped route only; it does not
  apply to `/deliveries`, and a worker who runs the customer redaction function against this field
  has misread this contract — the entire reason #55 exists is for an operator to see the real
  provider/config error a customer must never see. `05-deliveries-mixed.html` illustrates this with
  "Resend API returned 401: invalid API key" — text that would violate every rule in
  "Customer-safe error copy" and is exactly right here.
- `delivery-provider-id` — **not required by this contract; additive if present.** #55's Scope list
  does not name `provider_message_id`, so this contract does not mandate it the way it mandates the
  five fields above — but see Notes item 8 below for why an implementer should probably render it
  anyway. `05-deliveries-mixed.html` shows it present on the `sent` row as an illustration of the
  additive case, not a requirement.

**Ordering.** "Most recent activity first," per #55's own Scope text. This contract does not pin a
single rendered timestamp column as the sort key — `delivery-sent-at` is absent on `queued` and
`failed` rows (same presence rule as `/outbox`), so no field that appears on every row could serve
as an independently-checkable sort key even if this contract wanted to name one. This is the same
open question Notes item 1 already raised about `outbox.sent_at`'s two conflicting meanings, now
inherited by `/deliveries` rather than newly introduced here. A sealed test can still assert
ordering: seed fixtures with known subjects/recipients and distinguishable *server-side* activity
times, then assert DOM order matches the expected sequence by row identity (subject + recipient),
not by reading a displayed timestamp back out.

## The provider seam (issue #51 — pinned, code-level, not HTTP-observable)

The sealed suite never imports or calls `MailProvider` directly — Playwright drives the deployed
HTTP surface, not internal TypeScript. Everything it can assert about #51 is mediated through
`outbox` row transitions after the #50 drain runs (see below). What follows is pinned so an
implementer and the test-author agree on the **config surface** and the **fake's deterministic
behavior**, both of which the acceptance environment depends on to exercise all three delivery
states without ever calling the real Resend API:

- `env.RESEND_API_KEY` — secret, `wrangler secret put RESEND_API_KEY`. Never in git, never in
  `.dev.vars`, never in a fixture (`CLAUDE.md`'s "no customer material" rule extends here by the
  same public-repo logic even though a key isn't customer material — #53's tracking issue is
  explicit: "never touches git. This repo is public.").
- `env.EMAIL_FROM` — var (not secret), replaces the hardcoded literal currently in
  `src/notifications.ts` (`"coord-portal <notify@intake.heurontech.com>"`). This contract pins that
  the acceptance environment's value stays exactly that literal, matching every existing ms-1 mock
  and the new ms-3 mocks — it does **not** pin the production value, which #52 changes once
  `mail.heurontech.com` is verified (a future contract amendment, not this one).
- `env.MAIL_PROVIDER` — **this contract's own invention, flagged as such: no issue names this
  var.** Pinned because *something* has to select the fake deterministically in the acceptance
  environment without depending on `RESEND_API_KEY` being absent (absence is supposed to mean
  "fail closed," not "use the fake" — those are different requirements and conflating them would
  make the fail-closed path untestable). `env.MAIL_PROVIDER === "fake"` forces the recording fake
  regardless of whether `RESEND_API_KEY` is set; set via `.dev.vars` (gitignored, per `CLAUDE.md`)
  for `npm run serve:acceptance` / `serve:test` only. Absent (production) ⇒ the real Resend
  implementation, gated by `RESEND_API_KEY` as below.
- **Fail-closed (pinned, from #53's "Human prerequisites"):** an unset or invalid
  `RESEND_API_KEY` in the real-provider path must never crash the scheduled handler and must never
  silently mark a row `sent`. This contract reads "fail closed... mark the row failed" as: the send
  attempt itself fails with a legible `last_error`, and that failure flows through the **same**
  attempts/backoff/give-up machinery as any other provider error — it does not skip straight to
  `failed` on the first attempt, it just can never succeed, so it reaches `failed` on schedule like
  any other permanently-failing row.
- **Deterministic fake failure hook (pinned, this contract's invention):** the fake succeeds for
  every recipient **except** one whose local-part contains the substring `mailfail`
  (case-insensitive) — e.g. `rota-mailfail@example.test` — for which it deterministically fails
  every call. This is the only black-box lever the sealed suite has to drive a row all the way to
  `failed` without waiting on a real, unpredictable provider outage. On success, the fake returns a
  non-empty opaque `provider_message_id`-shaped string (exact format not pinned — a test may assert
  non-emptiness, not a shape).

## Triggering the drain in the sealed suite (issue #50 — pinned, flagged as needing verification)

Nothing in #50 says how a black-box test invokes a Cloudflare **Cron Trigger**, because production
never needs to — Cloudflare's own scheduler calls it. Wrangler's local dev server (this repo pins
`wrangler ^4.0.0`, `main = src/index.ts`, ES module format) documents a dev-only route,
**`GET /__scheduled`** (optionally `?cron=<pattern>`), that invokes the Worker's exported
`scheduled()` handler directly, gated behind the `wrangler dev --test-scheduled` flag. This
contract pins that route as the trigger mechanism, since it is the only one that exists — but
flags it explicitly as **not yet confirmed against this repo's exact installed wrangler version**;
the #50 implementer should verify it against `node_modules/wrangler`'s own docs/changelog before
relying on it, and amend this contract if the path or flag differs.

**Concretely actionable, not just a caveat:** `package.json`'s `serve:acceptance`
(`wrangler dev --port 8789`) and `serve:test` (`wrangler dev --port 8788`) scripts do **not**
currently pass `--test-scheduled`. Without that flag, `/__scheduled` 404s and #50 has no way to be
gated at all — every issue's acceptance surface depends on this, so #50's implementer must add the
flag to both scripts (outside this milestone's `tests/acceptance/**` boundary; a normal source
change) or #50's sealed slice cannot pass in `coord acceptance run`.

**Retry/backoff budget (pinned, this contract's own choice — no issue states a number):**

- Give up after **5** attempts. If an implementer picks a different N, they should say so in the
  PR — the sealed suite needs *a* number to bound its polling loop against, and 5 is this
  contract's default, not a discovered fact.
- Backoff between attempts must stay short enough that a sealed test polling `/__scheduled`
  (with brief, e.g. ≤2s, pauses between calls) observes a `mailfail`-addressed row reach `failed`
  well inside a **60-second** total budget. Production backoff timing beyond that bound is not
  this contract's concern; keeping it short costs nothing at this repo's mail volume and buys a
  fast, deterministic gate.

**Claiming safety (issue #50's "the thing to get right" — pinned as an observable invariant, not
an implementation mandate):** a black-box test may fire two overlapping `GET /__scheduled` requests
concurrently and assert the affected row reaches exactly the outcome consistent with **one** send —
e.g. `status="sent"` with `delivery-attempts` absent (a first-try success renders no attempts block
per the vocabulary above) rather than any doubled side effect. This contract does not pin *how*
(`UPDATE ... WHERE status = 'queued'` + `meta.changes`, per #50's own suggested guard) only that a
customer must never observe evidence of a double-send.

## `outbox` schema additions (issue #49 — pinned because #49 explicitly commits to these names)

- `status TEXT NOT NULL CHECK (status IN ('queued','sent','failed'))`, existing rows migrate to
  `queued`.
- `provider_message_id TEXT` (nullable) — set only when `status = 'sent'`.
- `attempts INTEGER NOT NULL DEFAULT 0`.
- `last_error TEXT` (nullable) — the raw provider/operator-facing string; see "Customer-safe error
  copy" for why this is never rendered verbatim.
- `sent_at` — see Notes, item 1: this is a genuine conflict in #49's own text, not silently
  resolved here.
- New numbered migration. `origin/main`'s `migrations/` directory holds `0001`–`0009` as of this
  Gate-A's authoring time (2026-08-10) — per #49's own note ("check `origin/main`'s migrations
  directory at the moment you write it"), the implementer must re-check rather than assume `0010`
  is still free.
- `e2e/smoke.spec.ts` currently pins `/schema 0009/` (`e2e/smoke.spec.ts:19`). Per #49's own note,
  this pin moves in the same commit that adds the migration.

## Notes — open questions and ambiguities (not resolved by this contract)

1. **`sent_at`'s meaning conflicts between the existing schema and #49's ask, and #49 does not
   notice the conflict.** Today's `0009_notifications.sql` sets `outbox.sent_at` at **insert**
   time (record-creation time — the row is written the moment the portal *decides* to send, which
   ms-1's own migration comment calls "not a delivery log"), and `GET /outbox` currently orders by
   it. #49 asks for a `sent_at` that means **delivery** time ("`attempts`, `last_error`, `sent_at`"
   listed alongside fields that only make sense post-drain). Those are two different timestamps.
   This contract does not silently pick one: it pins only that `delivery-sent-at` (the DOM hook)
   must be absent until `status = 'sent'` and, when present, must reflect actual delivery time —
   the implementer decides whether that means repurposing the existing column (and adding a new
   `created_at`/`queued_at` for list ordering) or adding a distinct new column and leaving the old
   one as creation time. Either is compatible with this contract's DOM; a worker should not assume
   #49's field list was written with the existing column's current semantics in mind.
2. **List ordering is unchanged from ms-1 (oldest first) — not re-pinned by #49 or #50, inferred
   here.** Given item 1's ambiguity, "oldest first" is safest read as "oldest by whatever the
   implementer uses for creation order," not literally `ORDER BY sent_at ASC` — that column's
   meaning is exactly what's in question.
3. **#49's own motivating text ("the operator has no way to see a stuck notification") describes
   an operator need this milestone's actual scope does not build a route for.** The only pinned
   route, `GET /outbox`, is customer-scoped (`to_email` = caller), same as ms-1 — there is no
   operator-wide view across all customers' outbox rows anywhere in #49/#50/#51's Scope sections.
   This contract resolves the *visible* gap (a customer must not see a raw provider error) but does
   not invent an operator route no issue asked for. An operator who needs to find every currently
   `failed`/stuck row today has no in-product surface for it — `wrangler d1 execute` against the
   deployed D1 database is the only path — which is worth a follow-up issue if the fleet operator
   actually needs it, per this milestone's own "#8 lesson" about not inventing a slice for
   something with no issue driving it.

   **Resolved by amendment: issue #55, filed against this exact paragraph, is that follow-up
   issue.** See "The operator delivery view (issue #55)" above — `GET /deliveries` is now pinned.
   This paragraph is left intact rather than deleted because #55's own body quotes it verbatim as
   its justification; deleting it would break that cross-reference for anyone reading #55 alongside
   this file.
4. **Why `provider_message_id` is not on the customer page:** it is Resend's opaque internal
   tracking id, useful for support correspondence with the *provider*, not for the customer. Not
   PII, not sensitive — this contract excludes it from the customer page on minimalism grounds
   (nothing in #49 says it must render there, only that the column must exist so "a delivery
   question can be answered later" — answerable by direct D1 lookup), not on a security ground. A
   worker who renders it anyway does not violate this contract.
5. **`env.MAIL_PROVIDER` and the `mailfail`-substring fake hook are this contract's own inventions
   (see "The provider seam"), flagged the same way `ms-2/contract.md`'s Notes item 1 flags its own
   invented operator-identity mechanism.** If #51 ships a different selection mechanism or a
   different deterministic-failure hook, this contract's *black-box behavior* (fake selectable
   without a real key; some address deterministically fails) should still hold; only the exact
   config var name / magic substring would need a contract amendment.
6. **`/__scheduled` is unverified against this repo's exact wrangler version** — see "Triggering
   the drain". Flagged prominently because every one of #50's acceptance assertions depends on it
   existing; if it does not, this is a Gate-A blocker, not a Fix-round issue, and should come back
   to this contract rather than being worked around silently in the suite.
7. **#52 is `oracle:exempt` by its own issue text** ("No code, no black-box surface — this issue is
   `oracle:exempt` by design, not by omission"). This contract pins nothing for it and expects no
   acceptance slice to be authored against it. Its "Done means" criteria (Resend reports the domain
   verified; a mail-tester-style check passes SPF/DKIM/DMARC; a reply lands in a real inbox) are
   human-verified once, per #53's own text — not automatable within this repo's driver.
8. **`delivery-provider-id` is deliberately not mandated on `/deliveries` even though the whole
   point of the screen is diagnosis.** (Added with the #55 amendment.) #55's own Scope list names
   only `status`, `attempts`, `last_error`, `sent_at`, recipient and subject — not
   `provider_message_id` — so this contract does not require it. But Notes item 4 above already
   observes that column exists precisely so "a delivery question can be answered later," and
   `/deliveries` is the first and only in-product surface where that answer could actually be read
   without a direct D1 query. An implementer who omits it has still met this contract; one who
   includes it (as `05-deliveries-mixed.html` illustrates) has arguably finished what #49 started.
   Flagged rather than silently pinned either way, per this contract's own rule about not resolving
   a genuine issue-text gap on the workers' behalf.
9. **The `/deliveries` route path and the `nav-deliveries` topbar addition are this contract's own
   inventions, not #55's** (#55 explicitly calls the route name "a proposal, not a requirement" and
   says nothing about navigation at all). Flagged the same way Notes item 5 flags `MAIL_PROVIDER`:
   if a worker ships a different path or wires navigation differently, this contract's black-box
   *behavior* — an operator-only, unscoped, most-recent-first delivery list, 404 for anyone else —
   should still hold; only the exact path string and nav `data-testid` would need a further
   amendment.

## Ownership (single-writer, unchanged)

`outbox` remains entirely portal-owned — the sync bridge has no opinion on delivery status, same as
ms-1's contract already established for the table as a whole. No field this milestone adds is ever
written by a bridge push; `CLAUDE.md`'s single-writer rule is unaffected.

## Synthetic data

All addresses, subjects, and bodies in `mocks/` are invented, per `CLAUDE.md`'s "No customer
material in git" rule and the same convention `ms-1/contract.md` and `ms-2/contract.md` state
explicitly. `example.test` is a reserved TLD; the `mailfail` local-part substring pinned above for
the fake's deterministic-failure hook is itself synthetic and safe to commit into acceptance
fixtures. Any acceptance spec written against this contract must use synthetic fixtures of its own
— never a real address, even the operator's own reply-routing inbox from #52.
