# ms-5 — Email intake (`intake@heurontech.com` as a real front door) — Gate-A contract

Written by an independent mock-author agent from milestone tracking issue **#160** and the 9 open
issues filed under it (#161–#169), before and without sight of any implementation. This is the
black-box surface: route paths, screen text, `data-testid` hooks, schema column names, and
config-var names the milestone's workers and the independent `test-author` agent must agree on
without a shared session.

**A material limitation, stated up front rather than glossed over:** the briefing this agent
received quoted every issue body but several were cut off mid-sentence before this agent could read
them in full (github truncates long bodies in the coordinator's own briefing format). Every place
that truncation actually mattered to a decision below is called out inline and again in "Notes —
open questions", with the exact sentence the text broke on. Where this contract had to invent a
concrete detail to have something checkable at all, it is flagged the same way `ms-3/contract.md`
flags `MAIL_PROVIDER` and the `mailfail` hook: **the black-box behavior is pinned; the exact name,
number or string chosen to make it testable is this contract's own invention, not a discovered
fact, and an implementer who ships a different one has not violated this contract as long as the
underlying behavior holds.**

Driver: `web-playwright`. Medium: static HTML, no build step, no framework, no live data, styled
against the real `public/tokens.css` — same convention `ms-1`–`ms-4`'s contracts established.

Design of record: `docs/CUSTOMER_PORTAL.md` (`claude-coordinator`) and this repo's own
`docs/CLOUDFLARE.md` § "Mail" and § "The MX records on `mail.<domain>` are load-bearing" — the
apex MX (Zoho) is never touched; only Cloudflare Email Routing's catch-all on
`mail.heurontech.com` changes.

## Why this milestone has one real screen, not several

Nine issues, one new operator page. EM-1/EM-2/EM-3 are seam, state-machine and pure-function work
with no DOM of their own (same posture ms-3's contract took for #50/#52 — "no screen, only the
state transitions the mocks already show the endpoints of"). EM-4's lead is rendered by `/leads`,
unchanged (ms-4's own mocks already cover it — see "Mock inventory" below for why it is not
re-rendered here). EM-5's thread message is rendered by the *existing* `message-thread` component
(`src/routes/submission.ts`, `data-testid="message-item" data-author-role="customer"`) — EM-5 adds
no new hook, it just adds a new *way* a `messages` row gets written. EM-8 is a config-var change
with no code surface. That leaves exactly one new screen, `/replies` (EM-6), plus one new dev-only
test door (EM-1) that exists so the sealed suite can drive the whole pipeline without a real inbox.

## Mock inventory (`mocks/`)

| File | Screen state | Route it represents |
|---|---|---|
| `01-replies-list.html` | Three pending drafts: a matched-thread reply, an unrouted reply, a stranger/lead reply | `GET /replies` |
| `02-replies-empty.html` | No pending drafts anywhere | `GET /replies` |
| `03-reply-detail-matched.html` | One draft, router rung 3 (known client, one project), no runner-up, no attachments | `GET /replies/:id` |
| `04-reply-detail-unrouted.html` | One draft, router rung 6 ambiguous case, two candidates, "Change routing" panel open, one attachment dropped | `GET /replies/:id` |
| `05-reply-detail-lead.html` | One draft, router rung 6 stranger case — sender became a `leads` row, no routing panel, no promote button | `GET /replies/:id` |

**No mock for `/leads/:id` showing an email-sourced lead.** EM-4's own text is explicit that this
is "the *same row* `POST /start` writes, via the *same function*... promotable from the same
triage screen" — `ms-4/mocks/`'s existing `/leads/:id` mocks already are that screen, and
re-rendering it here would either duplicate them pixel-for-pixel or drift from them for no reason.
The one thing EM-4 adds to a lead's own detail screen — a link back to the `inbound_emails` row
that produced it — is pinned as plain text below (§ "`/replies/:id` — pinned `data-testid` hooks",
the `originating-email` hook), not mocked separately, the same restraint `ms-3/contract.md` took
for issues with no screen of their own.

**No mock for `POST /__email`.** It is a dev-only JSON test door (see "The inbound test door"
below), not a rendered page — same category as ms-3's `GET /__scheduled` and `GET /__outbound`,
neither of which has a mock either.

## Route surface (pinned)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/replies` | operator (`readOperator`, same as `/leads`/`/deliveries`) | every **pending** `intake-reply` draft, newest first |
| `GET` | `/replies/:id` | operator | one draft — the message as received, the router's decision, the editable draft, the four actions |
| `POST` | `/replies/:id/approve` | operator | writes the (possibly edited) subject/body, `approval_state = 'approved'`, stamps `approved_at`/`approved_by`, clears `claimed_at` — EM-6's own table, row 1, quoted verbatim in its issue text |
| `POST` | `/replies/:id/discard` | operator | `approval_state = 'rejected'`. Terminal, never sends — EM-6's own table, row 2, quoted verbatim |
| `POST` | `/replies/:id/route` | operator | **this contract's own name and shape — flagged, see below** |
| `POST` | `/replies/:id/promote` | operator | EM-7 — creates a submission in the matched project (or, for an unrouted row, the project the operator just picked via `/route`), via `createSubmissionStatements`, guarded on "this inbound email has not been promoted" |
| `POST` | `/__email` | dev/acceptance only, gated on `env.MAIL_PROVIDER === "fake"` — see "The inbound test door" | simulates one inbound message reaching the Worker's `email()` export |

No other route is pinned. The `email()` Worker export itself (EM-1) is not HTTP surface — Cloudflare
Email Routing invokes it directly, the same relationship `scheduled()` has to `GET /__scheduled`
(ms-3's own precedent) — so it is only reachable, from a black-box test, through `/__email`.

### `/replies/:id/route` — flagged as this contract's own invention

EM-6's own text lists "Four actions" but its table was cut off after row 3's *name* ("Change
rou...") and before its *effect* — this agent never saw what "Change routing" is supposed to do,
only that a third action exists and is named starting "Change rou[ting]". Two things this contract
does NOT silently resolve:

1. Whether EM-6's unseen fourth action **is** EM-7's "promote to a submission" (issue #167 is
   filed as its own issue, "After EM-6", which reads consistently with EM-6's own table having a
   row that just says "see #167" — but this agent cannot confirm that from truncated text).
2. What "Change routing" does to an already-matched (non-ambiguous) row, if anything.

What this contract DOES pin, because #163 and #165 are unambiguous about the underlying need — an
operator must be able to correct a router that guessed wrong or parked ambiguously, before either
sending a reply that thanks the wrong project or promoting into the wrong one:

- `POST /replies/:id/route` accepts a form field `target`, one of: the id of a project the router
  named as a candidate (`reply-routing-option`, below), or the literal `lead` (park this row for
  lead creation instead of any project). Anything else is a no-op, same "malformed input never
  looks like an error" convention `postLeadReassign` already uses.
- Re-targeting updates the `inbound_emails` row's own routing columns (see schema below) and
  re-derives the draft's addressee/content accordingly; it does **not** re-run the router, and it
  does not touch `approval_state` — an operator correcting the target still has to separately
  Approve or Discard.
- Rendered as a disclosure, closed by default on an unambiguous match and **open by default** on an
  unrouted row (mock 04) — mirroring `reassignPanel`'s existing checkbox-toggle mechanism
  (`reassign-toggle`/`reassign-panel`/`reassign-open-button`/`reassign-cancel`) under new hooks:
  `reply-routing-toggle`, `reply-routing-panel`, `reply-routing-open-button`, `reply-routing-cancel`,
  `reply-routing-form`, one `reply-routing-option` (radio, `data-target-id`, value = a candidate
  project's id) per candidate, one further `reply-routing-option-lead` (radio, `value="lead"` —
  present only when the row has at least one project candidate to abandon in favor of a lead;
  absent on the stranger case, mock 05, which has no panel at all) and `reply-routing-submit`.

If an implementer reads EM-6's actual (untruncated) fourth action differently, that is a contract
amendment, not a free choice — say so in the PR, the same instruction every prior ms contract in
this repo gives for its own flagged inventions.

## `/replies` — pinned `data-testid` hooks

Operator screen, `operatorTopbar()` with a new nav entry (see "Navigation" below). Gated exactly
like `/leads`/`/deliveries`: no operator, or no Access identity at all, gets `leadsNotFound()`'s
identical 404 — never a distinct error, never a login redirect.

- `replies-list` — the container, present iff at least one `pending` draft exists.
- `replies-list-empty` — present **instead**, never alongside (`/leads`'s `leads-list`/
  `leads-list-empty` convention, not `/outbox`'s always-present one).
- `reply-row` — one per pending draft. Carries `data-rung` (the router's rung, `1`–`6`, as a bare
  integer string) and `data-routed-kind` ∈ `message` / `unrouted` / `lead`.
- `reply-sender-email` — the inbound `from_email`, verbatim. Same "no redaction on the operator
  side" posture `/deliveries`' `delivery-recipient` already established — an operator triaging
  intake needs the real address.
- `reply-sender-name` — present iff the inbound message carried a display name; absent otherwise
  (same optionality `nameBlock` already gives a lead's own name).
- `reply-subject` — the inbound message's own subject line, verbatim.
- `reply-received-at` — when the message arrived.
- `reply-auth-result` — the raw `inbound_emails.auth_result` value. Vocabulary not pinned (EM-1's
  own text names the column, not its values) — a test may assert presence and non-emptiness only.
- `reply-route-badge` — short decision summary, `data-routed-kind` mirroring the row's own. Text is
  illustrative (`mocks/01`), not pinned verbatim — a test may assert `data-routed-kind` and that the
  matched project's/lead's own name or reference appears somewhere in the badge's text, not an
  exact sentence.
- `reply-attachments-dropped` — present iff `inbound_emails.attachment_count > 0` (EM-9). Text not
  pinned verbatim; must contain a base-10 integer matching the count. **Absent** when the count is
  zero — same "present-iff" convention `/deliveries`' `delivery-attempts` already uses.
- `review-reply` — link to `/replies/:id`, same role `review-lead` plays on `/leads`.

## `/replies/:id` — pinned `data-testid` hooks

`main[data-testid="reply-detail"]`, carrying the same `data-rung` / `data-routed-kind` the list row
does. `back-to-replies` — link back to `/replies` (`back-to-leads` precedent).

**The message as received** (EM-6's own heading, quoted):

- `reply-sender-email`, `reply-sender-name` (optional), `reply-subject`, `reply-received-at`,
  `reply-auth-result`, `reply-attachments-dropped` (optional) — identical hooks and presence rules
  to the list row above; a sealed test may reuse the same assertions against either screen.
- `reply-original-body` — the inbound message's own `body_text`, verbatim, unredacted (an operator
  deciding whether to approve a reply has to be able to read what it's replying to — there is no
  customer-safety boundary crossed by an operator reading a message addressed to the business).

**What the router decided** (EM-6's own heading, quoted: "and which rung decided it, with the
reason and the runner-up... An operator who cannot see why a match was made cannot sensibly
disagree with it"):

- `reply-route-decision` — human-readable summary of the outcome (`data-routed-kind` mirrored as an
  attribute on this element too, for a test that only wants to query one node).
- `reply-route-reason` — non-empty, human-readable. Exact wording not pinned — this agent received
  only rungs 1–4 of #163's 6-rung ladder before the issue body cut off (see "The router ladder"
  below); a test may assert non-emptiness and, for rungs 1–3 (exact matches), that the reason names
  the mechanism (envelope address / quoted reference / single-project client) rather than a vague
  placeholder.
- `reply-route-runner-up` — present iff the router actually had a second candidate it did not pick
  (rung 4's scoring case, and the unrouted case). **Absent** on an exact-match rung (1–3) or a
  stranger (rung 6, no client at all) — there is nothing to be a runner-up to.
- `reply-route-target` — plain text, **never a link**, naming what this routed to (a project's
  title, or, for the stranger case, the `LEAD-XXXXXX` reference). Same reasoning
  `promotedReference` in `src/routes/leads.ts` already gives for its own plain-text reference: an
  operator's own Access identity is never a customer's, so a link into `/leads/:id` would 404 for
  the person clicking it just as often as it would work, and a link into a project detail page
  crosses a boundary this contract does not otherwise pin. **Exception:** for the stranger case
  specifically, `originating-email` is instead rendered on the *lead's own* `/leads/:id` screen (a
  new, small addition to that existing template) as a plain-text back-reference — "This lead came
  in by email" — completing the link EM-4's own text asks for ("so `/replies` and future triage can
  get from one to the other") without adding a live cross-link either direction.

**The draft, editable** (EM-6's own heading: "editable. Proof-reading that cannot correct a typo is
not proof-reading"):

- `reply-approve-form` — `method="POST"`, `action="/replies/:id/approve"`. Contains:
  - `reply-subject-field` — text input, initial value = the drafted subject.
  - `reply-body-field` — textarea, initial value = the drafted body.
  - `reply-approve-button` — submit, "Approve & send" (or equivalent — wording not pinned, per
    every prior ms contract's own posture on button copy).
- `reply-discard-form` — separate `<form>`, `action="/replies/:id/discard"`, containing only
  `reply-discard-button`.
- The "Change routing" disclosure — see "`/replies/:id/route`" above for its hooks. **Absent
  entirely** on the stranger/lead case (mock 05): there is no project candidate to re-target a row
  that already became a `leads` row, and EM-3's rung 6 stranger case has no "known sender" for a
  routing decision to be wrong *about*.
- `reply-promote-form` — `action="/replies/:id/promote"`, `reply-promote-button` ("Promote to a
  submission"). **Present** for `data-routed-kind="message"` and `"unrouted"`; **absent** for
  `"lead"` — a stranger's inbound email already has its own promotion path, the existing
  `promote-lead-form` on `/leads/:id` (unchanged by this milestone), and a second promote button
  here would be two entry points to the same act with no way to tell a test (or an operator) which
  one is authoritative.

## Navigation (pinned, additive)

`operatorTopbar()` (`src/render.ts`) gains a fifth `OperatorNavCurrent` value, `"replies"`, and a
fifth nav link, `nav-replies` → `/replies`, alongside the existing `nav-leads` / `nav-deliveries` /
`nav-requests` / `nav-clients` — same `aria-current="page"` convention. **Required** on
`/replies`/`/replies/:id` themselves (every mock below shows it). Whether `topbar()`'s own
`operatorLinks` block (the customer-facing header's operator section, issue #103) also grows a
`nav-replies` entry is **not pinned by this contract** — flagged as additive-if-present, not
required, the same posture ms-3's Notes item 9 took for `nav-deliveries` before #103 existed.

## The router ladder — what this agent actually saw (issue #163)

Pinned, verbatim, because the issue text was intact this far:

| # | Rung | Kind |
|---|---|---|
| 1 | The address it was delivered to — `intake+SUB-XXXXXX@mail.heurontech.com`, the envelope recipient (`inbound_emails.to_email`, not the `To:` header) | exact |
| 2 | A reference quoted in the subject or body — `SUB-XXXXXX` / `LEAD-XXXXXX`, anywhere including the quoted original | exact |
| 3 | Sender is a known client with exactly one project (`getClientRecordByEmail`, plus `clients.cc_emails`) | exact |
| 4 | Known client, several projects — scored, starting with a project whose newest submission is waiting on the customer (`awaiting-signoff`, `needs-input`, `quality-check`) | heuristic |

**Cut off after rung 4's first scoring criterion.** This agent never saw the rest of rung 4's
scoring order, rung 5's definition, or rung 6's precise boundary. From EM-4's and EM-5's own text
(both intact) this contract can still pin two black-box facts about the tail of the ladder without
knowing its internals:

- Rung 6 covers **two** distinct outcomes, not one: EM-4 calls it "nobody we know" (no `clients`
  match at all → a `leads` row, `data-routed-kind="lead"`); EM-5 calls a *different* case "rung 6's
  ambiguous case (as opposed to its stranger case, EM-4)" → parks unrouted with candidates,
  `data-routed-kind="unrouted"`. This contract reads that as: rung 6 is reached whenever rungs 1–5
  all miss, and it then branches on whether the sender matches a known client at all (ambiguous →
  unrouted) or not (stranger → lead) — **this branching rule is this contract's own inference**,
  not confirmed against #163's actual text, and is flagged for the same reason as the routing-action
  question above.
- "Guessing never" (#163's own subtitle) means rung 6 unrouted must never silently pick a project —
  `mocks/04` shows exactly that: two candidates rendered, neither pre-selected as if chosen, both
  offered as equal radio options in the routing panel (contrast `clientMatchSection`'s rung-3-style
  pre-selection of the newest project, which only applies to an *exact* match).

An implementer should read #163's actual, untruncated text before relying on any of the inferences
in this section — they are this contract's best reconstruction from partial information, not a
substitute for the issue itself.

## The inbound test door — `POST /__email` (pinned, flagged as invented shape)

EM-1 names this exact door ("the `POST /__email` test door") but the truncated briefing never
reached its request/response shape. Modeled on the one existing precedent for a dev-only mutating
test seam in this repo, `GET /__outbound` (`src/routes/outbound.ts`) — gated on
`env.MAIL_PROVIDER === "fake"`, `{error:"not_found"}` at 404 otherwise, so **no change to
`serve:acceptance`/`serve:test` is needed** (both already pass `--var MAIL_PROVIDER:fake`) —
unlike `GET /__scheduled`, which needed a new flag added to those scripts.

Request: `POST /__email`, JSON body:

```json
{
  "from": "sender@example.test",
  "fromName": "Optional Display Name",
  "to": "intake+SUB-ABC123@mail.heurontech.com",
  "subject": "Re: your project",
  "text": "Message body.",
  "messageId": "<optional-rfc822-id@example.test>",
  "attachments": 0,
  "autoSubmitted": false
}
```

`to` is the **envelope recipient** — EM-1's own words for why `to_email` must be this and not the
`To:` header ("this carries the plus-address token EM-3 rung 1 needs"). `fromName`, `messageId`,
`attachments` and `autoSubmitted` are all optional, defaulting to `null` / absent / `0` / `false`.
`attachments` is a bare count, not real MIME parts — this test door exists to exercise routing,
drafting, rate-limiting and loop-suppression outcomes, not `postal-mime` itself, which has no
black-box surface of its own (same "not HTTP-observable" reasoning ms-3's contract gives for
issue #51's provider seam).

Response, 200: `{"id": "<inbound_emails.id>", "disposition": "received" | "suppressed" |
"rate_limited"}`. This is the one mechanism the sealed suite has to drive `email()` at all — every
acceptance assertion in this milestone that depends on an inbound message existing goes through
this door. If it turns out not to match how `email()` is actually wired (the same risk ms-3's
contract flagged for `/__scheduled`, and correctly — see that contract's Notes item 6), that is a
Gate-A blocker, not a fix-round issue.

**Loop suppression (`autoSubmitted`).** EM-1's own text ("Never answer a machine. Set
`disposition = 'suppressed'`...") cut off before naming the actual detection rule. This contract
pins one testable lever — a request with `autoSubmitted: true` must produce `disposition:
"suppressed"`, no `leads` row, no `messages` row, no `outbox` row, regardless of any other field —
without asserting this is the *only* real-world signal `email()` uses (an `Auto-Submitted` header,
a `List-Unsubscribe` header, a missing `From` — any of these are plausible and none is confirmed).

## Schema — `inbound_emails` (issue #161, `migrations/0020_inbound_emails.sql`)

Columns EM-1's own text commits to by name (quoted, not this contract's invention): `id`,
`message_id`, `from_email`, `from_name`, `to_email`, `subject`, `body_text`, `received_at`,
`auth_result`, `disposition`. `UNIQUE (message_id, to_email)` where `message_id` is present. No FK
constraints (0016's own precedent, "referential integrity lives in the app code").

`disposition` vocabulary — only `'suppressed'` is named in the text this agent saw. This contract
pins two more, needed to make EM-9 and the ordinary case checkable at all, **flagged as invented**:
`'received'` (accepted, routed one way or another) and `'rate_limited'` (EM-9). A worker who names
these differently has not violated this contract as long as three dispositions exist and behave as
below.

Routing columns — EM-1's text says only "plus nullable routing columns EM-3/EM-4/EM-5 will fill,"
naming neither. **All of the following are this contract's own invention**, needed for
`/replies`/`/replies/:id` to have something to read:

| Column | Type | Set by | Meaning |
|---|---|---|---|
| `routed_kind` | `TEXT`, nullable | EM-3/4/5 | `'lead'` \| `'message'` \| `'unrouted'` |
| `routed_rung` | `INTEGER`, nullable | EM-3 | `1`–`6` |
| `routed_reason` | `TEXT`, nullable | EM-3 | `reply-route-reason`'s source |
| `routed_runner_up` | `TEXT`, nullable | EM-3 | `reply-route-runner-up`'s source, absent when there was none |
| `routed_lead_id` | `TEXT`, nullable | EM-4 | the `leads.id` this message produced |
| `routed_project_id` | `TEXT`, nullable | EM-5, or `/replies/:id/route` | the project a message or unrouted row is (now) attached to |
| `routed_submission_id` | `TEXT`, nullable | EM-5 | the submission `postMessage` appended to |
| `outbox_id` | `TEXT`, nullable | EM-4/EM-5 | the drafted reply this row produced, if any (absent for `suppressed`/`rate_limited`) |
| `promoted_submission_id` | `TEXT`, nullable | EM-7 | set once, idempotency guard |
| `promoted_at` | `TEXT`, nullable | EM-7 | companion to the above |
| `attachment_count` | `INTEGER NOT NULL DEFAULT 0` | EM-1/EM-9 | `reply-attachments-dropped`'s source |

## Schema — `outbox.approval_state` (issue #162, `migrations/0021_outbox_approval.sql`)

Pinned **verbatim from #162's own issue text**, which was intact through this section:

```sql
ALTER TABLE outbox ADD COLUMN approval_state TEXT NOT NULL DEFAULT 'not_required'
  CHECK (approval_state IN ('not_required','pending','approved','rejected'));
ALTER TABLE outbox ADD COLUMN approved_at TEXT;
ALTER TABLE outbox ADD COLUMN approved_by TEXT;
```

`DEFAULT 'not_required'` is load-bearing per #162's own words: every existing row and every
existing enqueue path (`recordNotificationForStatus`) is untouched, so the four existing
notification types keep sending unattended. **Do not widen `outbox.status`** — #162's own explicit
instruction, for the reason it gives: `status` is pinned by ms-3's sealed contract and
`src/notifications.ts`'s `fromRow` drops any row whose `status` it does not recognise, so a new
`status` value would make rows silently vanish from `/outbox` and `/deliveries`.

**Also needed, not named by #162's own (intact) text but required for EM-4 to write anything at
all:** `outbox.email_type`'s `CHECK` constraint (widened once already, 0015, for `preview-ready`)
must be widened again to include `'intake-reply'`. Flagged as a gap the same way ms-3's contract
flagged #49's own field-list gap (Notes item 1 there) — an implementer's migration must do this or
EM-4's very first `INSERT` fails its own `CHECK`.

**The drain clause (#162's own title: "one clause in the drain").** `src/drain.ts`'s `drainOutbox`
selects `WHERE status = 'queued'` today. This milestone must add exactly one more condition to that
`WHERE`: a row with `approval_state = 'pending'` must never be claimed, sent, or have its `attempts`
incremented by any cron tick, no matter how many ticks pass. Pinned as an **observable invariant**,
not a specific SQL clause: a sealed test may enqueue an `intake-reply` draft, fire `/__scheduled`
repeatedly, and assert the row is still `status = 'queued'`, `attempts = 0` — then `POST
/replies/:id/approve`, fire `/__scheduled` once more, and assert it reaches `sent` (via the
existing fake provider) on that next tick.

## Rate limiting (issue #169, flagged as invented numbers)

EM-9's own text: "Cap drafts created, per sender and in total, reusing the shape
`src/rateLimit.ts` already has." That module's own shape is a sliding window
(`WINDOW_MS = 5_000`) recomputed per request. This contract reuses the same window rather than
inventing a new mechanism, with its own numbers (not discovered anywhere in the truncated text):

- **Per sender:** more than **5** drafts within any 5-second window ⇒ every further message from
  that sender in-window gets `disposition = 'rate_limited'`.
- **Total:** more than **20** drafts across all senders within any 5-second window ⇒ same outcome,
  regardless of sender.

A `rate_limited` row is **still written** to `inbound_emails` (EM-9's own words: "still recorded...
it just does not earn a reply... should not erase the evidence of itself") — with `attachment_count`
and every other EM-1 column populated normally — but produces **no** `outbox` row, no `leads` row,
no `messages` row, and therefore **no `/replies` row at all** (there is nothing pending to review).
Whether a rate-limited row is visible anywhere in the product is explicitly **not pinned** — see
Notes below.

## Attachments (issue #169)

`attachment_count` (schema above) is set from the test door's `attachments` field (or, in
production, from however many MIME parts `postal-mime` reports as attachments — not itself
black-box observable). Two pinned, checkable consequences:

1. `reply-attachments-dropped` renders on both `/replies` and `/replies/:id` whenever
   `attachment_count > 0` — see the hook tables above for its exact presence rule.
2. The **drafted reply's own body** (`reply-body-field`'s initial value) must contain a sentence
   noting that an attachment was received and not saved, whenever `attachment_count > 0`. Exact
   wording not pinned (same "illustrative, not pinned" posture `src/notifications.ts`'s templates
   already get) — a test may assert the body contains the count as a base-10 integer and does not
   claim the attachment was kept, saved, or is retrievable.

## The templated reply — pinned invariants (issue #164, partially truncated)

EM-4's own text on the template ("Deterministic, rendered in the Worker... it never quotes
submission content and never discloses state... The CTA lands on an Access-gated page") is intact
through those sentences but cuts off at "Mirror the..." — this agent does not know what earlier
template it was told to mirror. Pinned anyway, because these sentences are unambiguous and the
rest of this codebase already gives a concrete referent for "the CTA lands on an Access-gated page"
(`src/notifications.ts`'s existing three templates all do exactly this):

- The drafted body (`reply-body-field`'s initial value) must **never** contain the sender's own
  message text back to them, verbatim or paraphrased — same "never quotes submission content"
  restriction the issue states.
- It must **never** name a submission status, a project name, or any other pipeline-state fact —
  "never discloses state."
- Every draft's implied call-to-action resolves to a URL behind this portal's own Access
  application (mirroring `ctaHref` in `src/notifications.ts` — `/submissions/:id`-shaped for a
  matched thread, `/leads/:id`-shaped is NOT applicable here since a stranger's own lead has no
  Access seat yet; the acknowledgement for a stranger names no URL a browser could follow, only the
  `LEAD-XXXXXX` reference to quote back, same as `/start`'s own receipt).
- Every existing FORBIDDEN-vocabulary rule ms-1's `14-notifications.spec.ts` and ms-3's
  "Customer-safe error copy" already pin (issue numbers, "branch", "commit", "worktree", "agent",
  "worker", "github", "daemon", provider/infra vocabulary) applies to every drafted body this
  milestone produces too — an intake-reply draft is exactly as customer-facing as any existing
  notification, and nothing in EM-4's text suggests otherwise.

## Ownership (single-writer, unchanged — CLAUDE.md)

`inbound_emails` and every column this milestone adds to `outbox` are entirely portal-owned. No
email address of any kind crosses the bridge — per the epic's own "coord never sees leads," a
stranger's inbound message produces a `leads` row exactly the way `/start` does, which by
construction emits no bridge event. A matched sender's inbound message produces a `messages` row
(0014's own four properties: append-only, moves no status, touches no design round or sign-off,
emits no bridge event) — unchanged even though this milestone adds a new *writer* of that table.
The only bridge event this milestone can ever cause is `submission.created`, and only via EM-7's
promotion path, which is explicitly required to be byte-identical in shape to the one `/intake`
and `promoteLead` already produce — the daemon never learns an email was involved, exactly as it
never learns a lead promotion was.

## Notes — open questions and ambiguities (not resolved by this contract)

1. **EM-1's exact loop-suppression detection rule is unknown to this agent** — the issue text cut
   off at "Never answer a machine. Set `disposition = 'suppressed'` and record t...". This contract
   pins only the `autoSubmitted` test-door lever (see "The inbound test door"), not the real-world
   header or heuristic `email()` actually inspects.
2. **EM-2's own reasoning for why `outbox.status` must not widen was cut off** after "...so the
   four notification types keep sending unattended and **ms-1's and ms-3...**" — this contract
   still pins the conclusion (verbatim SQL, above) because the conclusion itself was intact and
   consistent with ms-3's own sealed contract, which this agent could read directly.
3. **EM-3's rungs 4 (full scoring order), 5, and 6 (exact boundary)** are not fully known — see
   "The router ladder" above for exactly what is pinned versus inferred.
4. **EM-5's "unrouted" and EM-4's "stranger" may or may not both be sub-cases of literally the same
   rung 6**, or may be two different rungs this agent never saw named. The `routed_kind` vocabulary
   above (`lead` / `message` / `unrouted`) is chosen to be correct under either reading.
5. **EM-6's fourth action and "Change routing"'s actual effect are unknown** — see
   "`/replies/:id/route`" above for what this contract invents in their place and why.
6. **EM-7's idempotency guard text was cut off** after "...so a double-click, a retry, or two
   concurrent promotes converge..." — this contract assumes it converges the same way `promoteLead`
   does (one `DB.batch()`, one guard predicate — "this inbound email has not been promoted", i.e.
   `promoted_submission_id IS NULL`), by direct analogy by `promoteLead`'s own doc comment
   (`src/leads.ts`), not because this agent saw EM-7's own conclusion.
7. **EM-8's warning that "the acceptance environment must not follow production here" was cut off**
   before saying what the acceptance environment must do *instead*. This contract does not pin
   `REPLY_TO`'s acceptance-environment value at all as a result — an implementer must read #168's
   actual text (not available to this agent in full) before touching `serve:acceptance`/
   `serve:test`'s existing `REPLY_TO`-adjacent behavior.
8. **EM-9's own "Files" list was cut off** mid-enumeration (`src/rateLimit.ts` · `src/inboundEmail.ts`
   · `src/notifications.ts`...) — not a black-box concern, noted only so an implementer does not
   assume the list above was exhaustive.
9. **Whether a `rate_limited` `inbound_emails` row is visible anywhere in the product is not
   pinned.** No issue text this agent saw describes a screen for raw, undrafted inbound rows (as
   opposed to `/replies`, which is drafts only) — the same "do not invent a route no issue asked
   for" restraint ms-3's contract Notes item 3 applied to `/deliveries` before issue #55 existed.
   If an operator needs to see rate-limited/suppressed traffic, that is a future issue, not
   something this contract invents a screen for.
10. **Whether `/replies` ever shows a row's history after it leaves `pending`** (approved/rejected)
    is not pinned. This contract reads EM-6's own "pending row" framing as meaning the list is
    pending-only and a row simply disappears once acted on — `/deliveries` (unchanged by this
    milestone) is where its eventual send status becomes visible again, once EM-8 lands and a
    plus-addressed `REPLY_TO` makes a real customer reply thread itself back through this pipeline.

## Synthetic data

Every address, name, subject and body in `mocks/` is invented, per `CLAUDE.md`'s "No customer
material in git" rule and the convention every prior ms contract in this repo states explicitly.
`example.test` is a reserved TLD (RFC 6761), safe to commit. Any acceptance spec written against
this contract must use synthetic fixtures of its own — never a real address, and never the real
`intake@heurontech.com` / `mail.heurontech.com` domains this milestone actually wires up.
