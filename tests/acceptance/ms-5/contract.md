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

**Amendment, applied after the fact:** the truncation above was itself a coord bug
(`MAX_ISSUE_BODY_CHARS`, a cap meant for a different command's cohort inference) rather than a
GitHub limit — every issue body is in fact much longer than 1500 characters. A follow-up pass
supplied this agent with the verbatim tail of all nine issues (chars 1500 onward, never seen the
first time) and asked it to re-check every invention and every item in "Notes — open questions"
against the real text. That pass is folded into the sections below in place — inventions that the
real text confirmed keep their pin with the "invention" flag dropped; inventions the real text
contradicted are corrected and marked **(corrected by amendment)**; genuinely new facts the tails
revealed (the `/__email` request format, the full router ladder, EM-6's actual fourth action, the
`Reply-To` mechanism, etc.) are marked **(confirmed by amendment)**. Eight of the original ten
"Notes" items are resolved this way; two survive because they are real product questions the issue
text never answered, truncated or not — see "Notes" at the bottom. Nothing below was walked back
just because it turned out to be avoidable — where an invention happened to match the real text, it
stays pinned as before.

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
no new hook, it just adds a new *way* a `messages` row gets written. **EM-8 is not the config-var
change this contract first assumed** — its own tail (`src/drain.ts`, `src/notifications.ts`) shows
it adds a `Reply-To` header to outbound mail, not just a value change **(corrected by amendment,**
see "Reply-To on outbound mail" below**)** — but it still renders nothing of its own; the correction
only affects that one screen-count sentence, not the count itself. That leaves exactly one new
screen, `/replies` (EM-6), plus one new dev-only test door (EM-1) that exists so the sealed suite
can drive the whole pipeline without a real inbox.

## Mock inventory (`mocks/`)

| File | Screen state | Route it represents |
|---|---|---|
| `01-replies-list.html` | Three pending drafts: a matched-thread reply, an unrouted reply, a stranger/lead reply | `GET /replies` |
| `02-replies-empty.html` | No pending drafts anywhere | `GET /replies` |
| `03-reply-detail-matched.html` | One draft, router rung 3 (known client, one project), no runner-up, no attachments, routing panel closed with a "become a lead instead" option (corrected by amendment — see `/replies/:id/route` below) | `GET /replies/:id` |
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

**No mock for `POST /__email`.** It is a dev-only test door that takes a raw RFC 822 blob (see "The
inbound test door" below — request format corrected by amendment, was previously and wrongly
modeled here as JSON), not a rendered page — same category as ms-3's `GET /__scheduled` and
`GET /__outbound`, neither of which has a mock either.

## Route surface (pinned)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/replies` | operator (`readOperator`, same as `/leads`/`/deliveries`) | every **pending** `intake-reply` draft, newest first |
| `GET` | `/replies/:id` | operator | one draft — the message as received, the router's decision, the editable draft, the four actions |
| `POST` | `/replies/:id/approve` | operator | writes the (possibly edited) subject/body, `approval_state = 'approved'`, stamps `approved_at`/`approved_by`, clears `claimed_at` — EM-6's own table, row 1, quoted verbatim in its issue text |
| `POST` | `/replies/:id/discard` | operator | `approval_state = 'rejected'`. Terminal, never sends — EM-6's own table, row 2, quoted verbatim |
| `POST` | `/replies/:id/route` | operator | EM-6's own third action, "Change route" — re-targets to an operator-chosen client/project/lead and re-renders the draft; see below for what's confirmed vs. still this contract's own invention |
| `POST` | `/replies/:id/promote` | operator | EM-7 — creates a submission in the matched project (or, for an unrouted row, the project the operator just picked via `/route`), via `createSubmissionStatements`, guarded on "this inbound email has not been promoted" **and**, confirmed by amendment, on `approval_state = 'pending'` (EM-6's own "every write is guarded" rule applies to all four of its actions — see `/replies/:id/route` below) |
| `POST` | `/__email` | dev/acceptance only, gated on `env.MAIL_PROVIDER === "fake"` — see "The inbound test door" | simulates one inbound message reaching the Worker's `email()` export |

No other route is pinned. The `email()` Worker export itself (EM-1) is not HTTP surface — Cloudflare
Email Routing invokes it directly, the same relationship `scheduled()` has to `GET /__scheduled`
(ms-3's own precedent) — so it is only reachable, from a black-box test, through `/__email`.

### `/replies/:id/route` — now confirmed by the issue's own text (amendment)

EM-6's own table, read in full, has exactly four rows: **Approve & send**, **Discard**, **Change
route**, and **Promote to a submission** ("EM-7"). Quoted verbatim: "**Change route** | re-run
against an operator-chosen client / project / lead, re-render the draft from the template, stay
`pending`." and "**Promote to a submission** | EM-7."

This resolves both things the original mock-author pass flagged as unknown:

1. **EM-6's fourth action is "Promote to a submission," and it is a separate row from "Change
   route"** — the two are distinct actions with distinct forms, exactly as this contract had
   already (independently) chosen to render them. That earlier choice keeps its pin; the
   uncertainty about *whether* they were the same action is gone.
2. **"Change route" is not a no-op on an already-matched row.** Its own row text is unqualified —
   it re-targets to "an operator-chosen client / project / lead" regardless of how the original
   match was reached. An operator must be able to say "this exact-match is still wrong" (a rung-3
   address match can be a real address behind the wrong intent) and redirect it, not only resolve
   an ambiguous rung-6 tie. **This corrects mock 03** (see below) — its previous "no options, just
   a note, nothing to submit" rendering assumed a no-op that the real text does not describe.

**What is pinned now:**

- `POST /replies/:id/route` re-targets the row to an operator-chosen **client, project, or lead**
  — three kinds of target, per EM-6's own words. The exact field encoding for "an operator-chosen
  client" (as opposed to one of the router's own candidate projects) is **still this contract's own
  invention** — no issue text this agent has seen, truncated or not, gives a request shape or
  describes a client-picker UI, and no mock renders one (same "pinned in prose only" restraint this
  contract already takes for `originating-email`, below). Concretely pinned, because every mock
  needs something submittable: a form field `target`, one of — the id of a project the router named
  as a candidate (`reply-routing-option`, `data-target-id`), or the literal `lead`
  (`reply-routing-option-lead`). Anything else is a no-op, same "malformed input never looks like an
  error" convention `postLeadReassign` already uses. A worker who also exposes a free-choice
  client/project picker beyond the router's own candidates has not violated this contract; one who
  ships *only* that and drops the two options above would.
- Re-targeting **re-renders the draft (subject and body) from the template** against the new
  target — EM-6's own words, tighter than this contract's prior "re-derives the draft's
  addressee/content" phrasing, which is now folded into this pin. It does not touch
  `approval_state` — EM-6's own words, "stay `pending`."
- **Newly confirmed guard convention:** EM-6's own text — "Every write is guarded `WHERE id = ? AND
  approval_state = 'pending'`, so a double-click converges instead of double-sending" — applies to
  **all four** of its own actions, including `/route` and `/promote`, not only `/approve` and
  `/discard`. A `POST` to any of the four action routes on a row that is not currently
  `approval_state = 'pending'` is a guarded no-op (same "guard every write" convention
  `src/drain.ts` and `src/leads.ts`'s promotion batch already hold to), not an error response.
- Rendered as a disclosure, closed by default on an unambiguous match and **open by default** on an
  unrouted row (mock 04) — mirroring `reassignPanel`'s existing checkbox-toggle mechanism
  (`reassign-toggle`/`reassign-panel`/`reassign-open-button`/`reassign-cancel`) under new hooks:
  `reply-routing-toggle`, `reply-routing-panel`, `reply-routing-open-button`, `reply-routing-cancel`,
  `reply-routing-form`, one `reply-routing-option` (radio, `data-target-id`, value = a candidate
  project's id) per candidate, one further `reply-routing-option-lead` (radio, `value="lead"`) and
  `reply-routing-submit`.
- **`reply-routing-option-lead` presence rule, tightened:** present whenever `data-routed-kind` is
  `"message"` or `"unrouted"` — i.e. whenever there is a project attached or candidate at all, even
  if it is the sole exact match and there is no *sibling* project to move to (mock 03 now shows
  this: one option, "become a lead instead," alongside a note explaining there is no other project
  on file). **Absent** only on the stranger case (`"lead"`, mock 05), which mirrors
  `reply-promote-form`'s own presence rule immediately below for the same underlying reason: there
  is no known sender for a routing decision to be wrong *about*.

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
- `reply-auth-result` — the raw `inbound_emails.auth_result` value. **Vocabulary now confirmed by
  amendment:** exactly one of `pass` / `fail` / `none`, the DMARC verdict EM-1 parses out of the
  message's `Authentication-Results` header (EM-1's own words). A test may assert the value is one
  of these three strings, not merely non-empty. Topology note carried over from EM-1's own text,
  not itself black-box-observable but relevant to how a synthetic fixture must be built: mail
  arrives via a Zoho forward, so the header that is trustworthy is the one **Zoho** stamped for the
  original sender, not one Cloudflare stamped for Zoho — a fixture's `Authentication-Results` header
  must be shaped accordingly for `auth_result` to come out as intended.
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
- `reply-route-reason` — non-empty, human-readable. Exact wording not pinned (per every prior ms
  contract's posture on copy, and unaffected by the amendment, which supplied behavior, not exact
  reason strings) — a test may assert non-emptiness and, for rungs 1–3 (exact matches), that the
  reason names the mechanism (envelope address / quoted reference / single-project client) rather
  than a vague placeholder. See "The router ladder" below for the full six-rung table.
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

## The router ladder — full six rungs (issue #163, complete by amendment)

Pinned, verbatim, now that the whole table has been seen:

| # | Rung | Kind |
|---|---|---|
| 1 | The address it was delivered to — `intake+SUB-XXXXXX@mail.heurontech.com`, the envelope recipient (`inbound_emails.to_email`, not the `To:` header) | exact |
| 2 | A reference quoted in the subject or body — `SUB-XXXXXX` / `LEAD-XXXXXX`, anywhere including the quoted original | exact |
| 3 | Sender is a known client with exactly one project (`getClientRecordByEmail`, plus `clients.cc_emails`) | exact |
| 4 | Known client, several projects — scored, starting with a project whose newest submission is waiting on the customer (`awaiting-signoff`, `needs-input`, `quality-check`) beats one that is not; then most recent activity; then word overlap between the subject line and the project name. A tie is not a winner — it falls to rung 6 as unrouted. | heuristic |
| 5 | Sender wrote in before but has no `clients` row. 0016 deliberately backfilled nothing, so historical rows carry a bare `customer_email` with `client_id IS NULL`. Match those on the address, then apply rung 4's scoring. | exact address, then heuristic |
| 6 | Nobody we know, or ambiguous → a lead. The default, and the safe one. | — |

**Rung 6's own two outcomes, now confirmed rather than inferred.** This contract's prior reading —
"rung 6 branches on whether the sender matches a known client at all" — is what the full text
actually describes, read together: rung 4's own row says a scoring tie "falls to rung 6 **as
unrouted**" (a known client, `data-routed-kind="unrouted"`, candidates recorded — #165's own
acceptance text: "an ambiguous two-project client parks as unrouted with both candidates
recorded"); rung 6's own row separately describes "nobody we know... → a lead" (no client match at
all, `data-routed-kind="lead"`). Both sentences are about rung 6; neither contradicts the other once
read as two sub-cases of the same fallback rung. The `routed_kind` vocabulary this contract already
pinned (`lead` / `message` / `unrouted`) needs no change.

**New rule, not previously known at all: rungs 3–5 require a DMARC pass.** EM-3's own text: "Anyone
can put any address in a `From:` header. Rungs 3, 4 and 5 — the ones that resolve an address into a
person — only fire when EM-1 recorded a DMARC pass [`auth_result = 'pass'`]. Anything else falls to
rung 6, where a human looks at it." Concretely, and checkable: a message whose sender address
matches a known client but whose `auth_result` is not `pass` must still fall through to rung 6 —
`data-routed-kind="unrouted"` if the address is a known client's (there is something to disambiguate
even though rungs 3–5 could not fire), the same outcome #163's own acceptance text names ("a
DMARC-fail message from a known client's address falling to unrouted rather than matching them").
Rung 1 (the plus-addressed envelope recipient) and rung 2 (a quoted `SUB-`/`LEAD-` reference) are
**not** gated on authentication — spoofing a `From:` header does not let an attacker forge the
envelope recipient Cloudflare Email Routing itself delivered to, or invent a reference token they
would have to already know.

**The decision shape, pinned:** the router returns the outcome, the rung, the reason, and the
runner-up "where rung 4 scored more than one candidate" (#163's own words) — confirming this
contract's existing `reply-route-runner-up` presence rule (rung 4's scoring case, and the unrouted
case it can fall into) needs no change.

**"Guessing never"** (#163's own subtitle) means rung 6 unrouted must never silently pick a project —
`mocks/04` shows exactly that: two candidates rendered, neither pre-selected as if chosen, both
offered as equal radio options in the routing panel (contrast `clientMatchSection`'s rung-3-style
pre-selection of the newest project, which only applies to an *exact* match).

## The inbound test door — `POST /__email` (request format corrected by amendment)

EM-1 names this exact door ("the `POST /__email` test door") and gates it exactly as this contract
had already guessed: modeled on `GET /__outbound` (`src/routes/outbound.ts`) — gated on
`env.MAIL_PROVIDER === "fake"`, `{error:"not_found"}` at 404 otherwise, so **no change to
`serve:acceptance`/`serve:test` is needed** (both already pass `--var MAIL_PROVIDER:fake`) — unlike
`GET /__scheduled`, which needed a new flag added to those scripts. That much is confirmed, unchanged.

**The request body is not JSON — corrected by amendment.** EM-1's own words: "`POST /__email` — the
dev/acceptance door. Takes a **raw RFC 822 blob** and runs it through the same handler." This
contract's original JSON body (`{"from":..., "to":..., "subject":..., "text":...}`) was this
contract's own invention built on a guess, and the guess was wrong — an implementer following it
would have built a door that cannot exercise the real `email()` handler's actual input shape (a
`ForwardableEmailMessage`-like object with real MIME headers), or the header-driven suppression
rules below. Corrected:

- The **POST body** is the raw text of an RFC 822 email — headers, a blank line, then the body —
  exactly the bytes `postal-mime` would parse in production. `Content-Type: message/rfc822` (or
  `text/plain`, since this is a synthetic test door and not itself subject to MIME sniffing) is
  reasonable; the exact content-type is this contract's own invention, unconfirmed by any issue
  text.
- Cloudflare's real `email()` export receives the **envelope** `to`/`from` separately from the
  message's own `To:`/`From:` MIME headers (this is precisely why EM-1's text insists
  `inbound_emails.to_email` must be the envelope recipient and not the `To:` header — "this carries
  the plus-address token EM-3 rung 1 needs"). A raw-blob-only POST body has no place to carry an
  envelope recipient that differs from the blob's own `To:` header. **This contract pins that the
  test door must accept the envelope recipient and sender out-of-band from the blob** — concretely,
  query parameters `?to=` and `?from=` — but the exact mechanism is still this contract's own
  invention; no issue text, truncated or not, describes it. A worker who instead reads the envelope
  recipient from a custom header (`X-Envelope-To`) has not violated this contract as long as the
  door still lets a test set an envelope recipient independent of the blob's own `To:` header.
- Every field this contract previously modeled as JSON is now a real RFC 822 header (or the body)
  in the blob instead: `From`, `To` (informational only — envelope `to` is what rung 1 reads),
  `Subject`, `Message-ID`, and the loop-suppression headers below. There is no `attachments` count
  field any more — a synthetic fixture that wants `attachment_count > 0` must include a real MIME
  multipart with attachment parts, which `postal-mime` counts the same way it would in production
  (not itself black-box observable, same "not HTTP-observable" reasoning ms-3's contract gives for
  issue #51's provider seam).

Response, 200: `{"id": "<inbound_emails.id>", "disposition": "received" | "suppressed" |
"rate_limited"}` — **still this contract's own invented shape**, unconfirmed by either the original
briefing or the amendment's tails, which describe the request format but not the response. This is
the one mechanism the sealed suite has to drive `email()` at all — every acceptance assertion in
this milestone that depends on an inbound message existing goes through this door. If it turns out
not to match how `email()` is actually wired (the same risk ms-3's contract flagged for
`/__scheduled`, and correctly — see that contract's Notes item 6), that is a Gate-A blocker, not a
fix-round issue.

**Loop suppression — the actual rule, confirmed by amendment.** EM-1's own text, in full: a message
gets `disposition = 'suppressed'` (recorded, with a reason; no draft, no routing) whenever **any**
of these hold:

- `Auto-Submitted` header present and not `no`
- `Precedence: bulk | list | junk`
- `List-Id` or `List-Unsubscribe` header present
- empty envelope sender (`<>`) — a bounce
- the sender address is one of this portal's own sending domains (`EMAIL_FROM`, `REPLY_TO`)

EM-1's own reasoning: "Two auto-responders talking to each other is the classic way this feature
embarrasses us; this is the check that prevents it." A synthetic fixture drives this by setting the
matching header directly in the raw blob (e.g. `Auto-Submitted: auto-replied`, or `Precedence:
bulk`) — there is no longer a single `autoSubmitted` boolean lever; any one of the five conditions
above is independently sufficient. A `suppressed` row produces no `leads` row, no `messages` row,
and no `outbox` row, regardless of any other field — this observable consequence was already pinned
and needs no correction, only the trigger mechanism did.

**Size caps, newly pinned (issue #161, confirmed by amendment).** `body_text` and the parsed summary
are capped; an oversized message is still recorded, never dropped silently — EM-1's own words: "An
oversized message is still recorded (truncated, flagged) — never dropped silently." This contract
adds one column to the schema below, **flagged as invented** (no cap size or column name is given
by the issue text): `body_truncated INTEGER NOT NULL DEFAULT 0`, set to `1` when `body_text` was cut
to fit the cap. `disposition` is unaffected by truncation — a truncated message still reaches
`'received'` (or whatever routing/suppression outcome it would otherwise reach) and is still
processed normally; truncation only affects the stored `body_text` and is visible only via
`body_truncated`, which is not currently surfaced on any pinned `data-testid` hook (no mock or issue
text asked for one).

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
| `body_truncated` | `INTEGER NOT NULL DEFAULT 0` | EM-1 | set to `1` when `body_text` was cut to fit the size cap — see "Size caps" above. Column name and existence are this contract's own invention; the underlying behavior ("truncated, flagged, never dropped silently") is EM-1's own words, confirmed by amendment. |

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

**`rejected` is not `failed` — confirmed by amendment, #162's own vocabulary table:**

| value | meaning |
|---|---|
| `not_required` | every row written before this milestone, and the four existing notification types |
| `pending` | an intake reply, waiting for a human |
| `approved` | a human read it; the next drain tick sends it |
| `rejected` | terminal, never sends |

`failed` (unrelated to `approval_state`, an existing `outbox.status` value) means the portal tried
five times and gave up — a fault, and `/deliveries` renders it as one. `rejected` means a human read
the draft and decided not to send it. A sealed test must not treat these as interchangeable: a
`rejected` row must never transition to `outbox.status = 'failed'` and must never be retried, the
same way `/deliveries` must never render an operator's own "no" as a fault.

**Confirmed, not merely inferred, by amendment:** `outbox.email_type`'s `CHECK` constraint (widened
once already, 0015, for `preview-ready`) must be widened again to include `'intake-reply'` **in the
same change** that adds `'intake-reply'` to `SENDING_TYPES` in `src/notifications.ts` — #162's own
words: "`fromRow` drops rows whose type it does not recognise, so a migration that lands without the
code change makes intake replies invisible." `migrations/0015_preview_reviews.sql` already
established the table-rebuild pattern SQLite needs to widen a `CHECK` constraint; #162's own text
says to follow it. This was previously flagged as this contract's own inferred gap; it is now a
directly quoted requirement, including the `SENDING_TYPES` half a prior pass had not surfaced at
all.

**The drain clause (#162's own title: "one clause in the drain"), confirmed verbatim by amendment:**

```
-- src/drain.ts, the batch SELECT and the claim UPDATE's own WHERE
  WHERE status = 'queued'
    AND approval_state IN ('not_required','approved')   -- new
    AND (claimed_at IS NULL OR claimed_at <= ?)
```

Both the batch SELECT and the claim UPDATE need the added clause independently — #162's own words,
"not just the SELECT — the claim is guarded independently for the same reason the lease is." Pinned
as an **observable invariant**, not merely a specific SQL clause (though the clause itself is now
known verbatim): a sealed test may enqueue an `intake-reply` draft, fire `/__scheduled` repeatedly,
and assert the row is still `status = 'queued'`, `attempts = 0` — then `POST /replies/:id/approve`,
fire `/__scheduled` once more, and assert it reaches `sent` (via the existing fake provider) on that
very next tick. A `rejected` row must never be sent and never retried, however many ticks run.
Every pre-existing row (`approval_state = 'not_required'`) must keep sending exactly as before —
#162's own acceptance text, all three clauses.

## Rate limiting (issue #169, numbers still invented, behavior now confirmed by amendment)

EM-9's own text: "Cap drafts created, per sender and in total, reusing the shape
`src/rateLimit.ts` already has." That module's own shape is a sliding window
(`WINDOW_MS = 5_000`) recomputed per request. This contract reuses the same window rather than
inventing a new mechanism, with its own numbers (**still not discovered anywhere in the issue text,
including the tails the amendment supplied** — the tails confirm the *behavior*, not the cap
values):

- **Per sender:** more than **5** drafts within any 5-second window ⇒ every further message from
  that sender in-window gets `disposition = 'rate_limited'`.
- **Total:** more than **20** drafts across all senders within any 5-second window ⇒ same outcome,
  regardless of sender.

A `rate_limited` row is **still written** to `inbound_emails` (EM-9's own words: "still recorded...
it just does not earn a reply... should not erase the evidence of itself") — with `attachment_count`
and every other EM-1 column populated normally — but produces **no** `outbox` row, no `leads` row,
no `messages` row, and therefore **no `/replies` row at all** (there is nothing pending to review).
**Confirmed by amendment**, #169's own acceptance text: "A sender past the cap gets a recorded
inbound row and no new draft; a sender under it gets both" — matches this pin exactly, only the
literal 5/20 threshold values remain this contract's own invention. Whether a rate-limited row is
visible anywhere in the product is explicitly **not pinned** — see Notes below.

## Attachments (issue #169, request-shape reference corrected by amendment)

`attachment_count` (schema above) is set from however many MIME parts `postal-mime` reports as
attachments when the test door's raw RFC 822 blob (see "The inbound test door," corrected above) is
run through the same handler as production — **no longer** a bare JSON `attachments` count field,
which was this contract's now-superseded invented request shape. A synthetic fixture that wants
`attachment_count > 0` must include a real MIME multipart with attachment parts in the blob it
posts. The count itself is not itself black-box observable beyond its effect on `attachment_count`.
Two pinned, checkable consequences, **confirmed by amendment** against #169's own acceptance text
("A message with an attachment records the count, drops the payload, and its draft's rendered body
says attachments were not received"):

1. `reply-attachments-dropped` renders on both `/replies` and `/replies/:id` whenever
   `attachment_count > 0` — see the hook tables above for its exact presence rule.
2. The **drafted reply's own body** (`reply-body-field`'s initial value) must contain a sentence
   noting that an attachment was received and not saved, whenever `attachment_count > 0`. Exact
   wording not pinned (same "illustrative, not pinned" posture `src/notifications.ts`'s templates
   already get) — a test may assert the body contains the count as a base-10 integer and does not
   claim the attachment was kept, saved, or is retrievable.

## The templated reply — pinned invariants (issue #164, "Mirror the..." resolved by amendment)

EM-4's own text on the template ("Deterministic, rendered in the Worker... it never quotes
submission content and never discloses state... The CTA lands on an Access-gated page") is intact
through those sentences and previously cut off at "Mirror the..." — now resolved: "Mirror the copy
`/start`'s receipt already uses, including the reference: the lead reference is what the sender
quotes back, and rung 2 reads it. Same voice, same promise, different channel." The stranger-case
draft (mock 05) is not this contract's own invention of tone — it is required to match `/start`'s
own existing receipt copy, word-for-word in spirit if not verbatim (exact wording is still not
pinned, per every prior ms contract's posture on copy). This also confirms, closing a loop EM-3's
rung 2 depends on: the `LEAD-XXXXXX` reference in the draft is exactly what a sender would quote
back in a follow-up email, and rung 2's "reference quoted in the subject or body" match depends on
that reference appearing in the sent draft in the first place.

**Idempotency, confirmed by amendment:** "An inbound message that is processed twice must produce
one lead and one draft. Key the draft on the `inbound_emails` row id with a `UNIQUE` constraint or
an `ON CONFLICT DO NOTHING`, the same belt-and-braces shape `outbox`'s existing `UNIQUE
(submission_id, coord_revision)` provides for notifications." A sealed test may re-deliver the same
message through `POST /__email` twice and assert exactly one `leads` row and one `outbox` row exist
afterward — already implied by this contract's existing acceptance framing, now backed by the
issue's own mechanism.

Pinned anyway, because these sentences are unambiguous and the rest of this codebase already gives a
concrete referent for "the CTA lands on an Access-gated page" (`src/notifications.ts`'s existing
three templates all do exactly this):

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

## Promotion idempotency (issue #167, confirmed by amendment)

EM-7's own cut-off sentence, completed: "...so a double-click, a retry, or two concurrent promotes
[converge on one submission]. Read back rather than assuming the race was won." This is the same
outcome this contract had already assumed by analogy to `promoteLead`'s own guard predicate
(`promoted_submission_id IS NULL`) — the analogy holds, and the mechanism (guard the write, then
read back the row instead of trusting that the request which issued the write is the one that won a
race) is now confirmed rather than assumed. Also confirmed: "The thread message EM-5 already wrote
stays. It is the record of what was actually said; promotion adds a submission, it does not rewrite
history" — a promoted row's own `messages` entry (EM-5's write) is untouched by EM-7's promotion,
consistent with "Ownership" below.

Acceptance, EM-7's own words: promoting an inbound email creates exactly one submission with one
`submission.created` event; promoting it twice still creates one; the submission lands in the
matched project; the original message row is unchanged. `migrations/0022_inbound_promotion.sql`
mirrors 0007's shape for leads' own promotion columns — this contract's `promoted_submission_id`/
`promoted_at` pair (schema above) already anticipated this shape and needs no correction.

## Reply-To on outbound mail (issue #168, confirmed by amendment — corrects "no code surface")

EM-8 is not a config-var-only change (see the correction in "Why this milestone has one real
screen" above). Its own text: every outbound notification must carry a `Reply-To` header bearing
its own submission reference — the plus-address scheme rung 1 already reads
(`intake+SUB-XXXXXX@mail.heurontech.com`), now used outbound as well as inbound. Pinned, black-box:

- Every outbound notification carries a `Reply-To` bearing its own submission reference, observable
  on the recorded fake payload via `GET /__outbound` (ms-3's existing test door — unchanged by this
  milestone, just given a new field to assert on).
- A reply delivered to that address routes by **rung 1** to that exact submission — this is the
  same rung 1 already pinned in "The router ladder," now confirmed to be fed by EM-8's own output as
  well as by the original intake link.
- A row with no submission reference (EM-8's own words: "should not occur") sends with the plain
  configured `REPLY_TO` address rather than a malformed one — "absent beats broken," the same rule
  `replyTo` and `html` already follow at that seam in `src/notifications.ts`.

**Resolves the previously-open question about the acceptance environment.** EM-8's own text, now
read in full: `serve:acceptance` and `serve:test` already override `EMAIL_FROM`, `MAIL_PROVIDER` and
`PUBLIC_BASE_URL` in `package.json` for exactly this reason, and ms-3's own contract pins the
acceptance `EMAIL_FROM` literal. **Changing the production `REPLY_TO` value must not come with an
edit to `tests/acceptance/**`** — EM-8's own words: "that is amending the oracle to match the
implementation, which is the one thing the sealed suite exists to prevent. If a sealed test looks
wrong, say so and stop." This contract does not pin a specific acceptance-environment `REPLY_TO`
literal (none is given, and per the instruction just quoted, pinning one that turns out wrong would
be worse than leaving it open) — an implementer must not touch anything under `tests/acceptance/`
to make this land, full stop; if the plus-address scheme conflicts with the existing acceptance
`REPLY_TO`/`EMAIL_FROM` literals ms-3 already pinned, that is a Gate-A-level conflict to raise, not
a sealed-test edit to make.

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

## Notes — open questions and ambiguities (updated by amendment)

Eight of the original ten items were truncation artifacts, not real ambiguity, and are resolved
in place above now that the tails are available:

- Item 1 (EM-1's loop-suppression rule) → "The inbound test door," "Loop suppression."
- Item 2 (EM-2/#162's cut-off reasoning) → "Schema — `outbox.approval_state`."
- Item 3 (EM-3's rungs 4–6) → "The router ladder."
- Item 4 (whether "unrouted" and "stranger" are the same rung) → "The router ladder," rung 6.
- Item 5 (EM-6's fourth action and "Change routing"'s effect) → "`/replies/:id/route`."
- Item 6 (EM-7's idempotency text) → "Promotion idempotency."
- Item 7 (EM-8's acceptance-environment warning) → "Reply-To on outbound mail."
- Item 8 (EM-9's truncated Files list) → resolved trivially; the full list is `src/rateLimit.ts` ·
  `src/inboundEmail.ts` · `src/notifications.ts` (the "we can't take attachments yet" line) ·
  `test/` · `e2e/`. Never a black-box concern; noted only for completeness.

Two items survive because they are genuine product questions the issue text never answered, in
full or in part — the amendment's tails do not touch either:

1. **Whether a `rate_limited` `inbound_emails` row is visible anywhere in the product is not
   pinned.** No issue text this agent saw, before or after the amendment, describes a screen for
   raw, undrafted inbound rows (as opposed to `/replies`, which is drafts only) — the same "do not
   invent a route no issue asked for" restraint ms-3's contract Notes item 3 applied to
   `/deliveries` before issue #55 existed. If an operator needs to see rate-limited/suppressed
   traffic, that is a future issue, not something this contract invents a screen for.
2. **Whether `/replies` ever shows a row's history after it leaves `pending`** (approved/rejected)
   is not pinned. This contract reads EM-6's own "pending row" framing as meaning the list is
   pending-only and a row simply disappears once acted on — `/deliveries` (unchanged by this
   milestone) is where its eventual send status becomes visible again, once a plus-addressed
   `REPLY_TO` (EM-8, now confirmed above) makes a real customer reply thread itself back through
   this pipeline.

One narrower invention surfaced *by* the amendment and remains open, not previously listed because
the earlier pass had no way to know it existed: the exact request encoding for "Change route"'s
operator-chosen **client** target (as opposed to one of the router's own candidate projects, or the
literal `lead`) — see "`/replies/:id/route`" above. No mock renders a client-picker and no issue
text, truncated or not, describes one.

## Synthetic data

Every address, name, subject and body in `mocks/` is invented, per `CLAUDE.md`'s "No customer
material in git" rule and the convention every prior ms contract in this repo states explicitly.
`example.test` is a reserved TLD (RFC 6761), safe to commit. Any acceptance spec written against
this contract must use synthetic fixtures of its own — never a real address, and never the real
`intake@heurontech.com` / `mail.heurontech.com` domains this milestone actually wires up.
