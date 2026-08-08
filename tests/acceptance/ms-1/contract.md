# ms-1 — Customer Portal v1 — Gate-A contract

Written by an independent mock-author agent from milestone tracking issue **#16** and the
9 open issues filed under it, before and without sight of any implementation. This is the
black-box surface: exact route paths, screen text, `data-testid` hooks and status vocabulary
that the milestone's workers and the independent `test-author` agent must agree on without a
shared session. Mocks are self-contained HTML under `mocks/`, one file per screen state, styled
against the real `public/tokens.css` so they read as the actual product, not a sketch of it.

Driver: `web-playwright`. Medium: static HTML, no build step, no framework, no live data — this
mirrors the convention already recorded in `CLAUDE.md` ("Mocks are self-contained static HTML
against a shared token stylesheet") and `docs/mocks/web/` in `claude-coordinator`.

No CLI surface is in scope here — this milestone is web-only (a separate `coord` CLI belongs to
the engineer side, in the other repo, out of scope for this milestone).

## Mock inventory (`mocks/`)

| File | Screen state | Route it represents |
|---|---|---|
| `01-intake-form.html` | Empty intake form | `GET /intake` |
| `02-intake-received.html` | Post-submit receipt, status `Describing` | `GET /submissions/:id` right after `POST` from `/intake` |
| `03-dashboard.html` | Submission list, one row per vocabulary state | `GET /submissions` |
| `04-submission-in-design.html` | Read-only rollup detail, status `In design` | `GET /submissions/:id` |
| `05-submission-awaiting-signoff.html` | Current design round + Approve/Request-changes actions | `GET /submissions/:id`, status `Awaiting your sign-off` |
| `06-request-changes.html` | Request-changes composer open | same route as 05, composer expanded — not a distinct URL |
| `07-round-history.html` | Versioned round history, oldest round still readable | `GET /submissions/:id/rounds` |
| `08-submission-needs-input.html` | Question raised, answer composer | `GET /submissions/:id`, status `Needs your input` |
| `09-submission-onhold.html` | On-hold detail — **provisional, see Notes** | `GET /submissions/:id`, status `On hold` |
| `10-submission-shipped.html` | Terminal detail | `GET /submissions/:id`, status `Shipped` |
| `11-email-signoff-ready.html` | Digest email: design ready for sign-off | not a portal route — transactional email |
| `12-email-needs-input.html` | Digest email: a question was raised | not a portal route — transactional email |
| `13-email-shipped.html` | Digest email: work shipped | not a portal route — transactional email |

`04-submission-in-design.html` is the template for **all four** non-actionable rollup states —
`In design`, `Planned`, `In progress`, `Quality check` — per issue #10: "Only customer-actionable
or terminal states cross the wall; request-changes reviews, merge conflicts and CI churn stay
hidden inside In progress / Quality check." Implementers render the identical read-only template
for all four; only `data-status`, the pill text, and the highlighted `timeline-step` change. A
separate mock per rollup state was judged redundant — the test-author should write one
parameterized spec, not four near-identical ones.

## Route surface (pinned)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | existing skeleton page (unchanged by this milestone) |
| `GET` | `/intake` | new-submission form |
| `POST` | *(from `/intake`)* | create a submission; redirects to `/submissions/:id` |
| `GET` | `/submissions` | the signed-in customer's own submissions, and only their own (issue #12) |
| `GET` | `/submissions/:id` | one submission; rendered content is a pure function of its status |
| `GET` | `/submissions/:id/rounds` | full versioned round history for that submission |

All of the above sit behind Cloudflare Access (issue #12) — every screen assumes a verified
identity is already present. `GET /api/whoami` (already implemented, `src/routes/whoami.ts`) is
the existing mechanism for reading it; note its own doc comment that `verified` is hard-coded
`false` until #1981 lands, so nothing customer-facing may branch on it being `true` yet.

**Not pinned by this contract:** how `:id` is minted, whether these are server-rendered
per-route pages or a static shell with client-side routing, and the exact request/response body
shape for the `POST` from `/intake` or for approve/request-changes/answer actions. None of
issues #8, #9, #11, #13 specify a JSON field schema or endpoint signature for portal-internal
writes — only the sync-bridge shape (#15) is discussed, and even that is explicitly marked "shape,
not final signature" in the issue body. Pin those in the issues themselves, not here, and treat
inventing a precise REST contract for them as scope this Gate-A deliberately declined.

## `data-testid` hooks (pinned)

Global, present in the header on every authenticated screen:
- `brand-home`, `nav-dashboard`, `nav-new`, `identity-email` (text = `signed in as {email}`)

Intake (`01`):
- `intake-form`, `field-outcome`, `field-audience`, `field-done-definition`, `field-constraints`
  (optional), `field-project-scope` (optional), `submit-intake` (button text: **"Send to the
  team"**)

Receipt (`02`):
- `intake-receipt`, `submission-reference` (text pattern: `Reference SUB-XXXXXX`),
  `view-submission`, `back-to-dashboard`

Dashboard (`03`):
- `submission-list`, `submission-row` (repeated, each carrying `data-status`), `status-pill`
  (repeated, each carrying `data-status` + canonical vocabulary text), `nav-new-cta`

Submission detail, all statuses:
- root `submission-detail` with `data-status` set to the slug (table below)
- `status-pill`, `submission-reference`

Rollup detail (`04`, and the other three rollup statuses by the same template):
- `status-timeline`, repeated `timeline-step` each with `data-step` (slug) and `data-current="true"`
  on exactly one, `rollup-copy`

Awaiting-sign-off (`05`):
- `design-round` (`data-round`, `data-verdict`), `round-number` (text: `Round {n}`),
  `round-history-link`, `outcome-definition`, `decomposition-list` / repeated
  `decomposition-item`, `mock-bundle-link`, `approve-button`, `request-changes-button`

Request-changes composer (`06`):
- `request-changes-form`, `changes-comment`, `next-round-note`, `cancel-changes`,
  `submit-changes`

Round history (`07`):
- `round-history`, repeated `round-entry` (`data-round`, `data-verdict`), `verdict-pill`
  (`data-verdict` one of `pending` / `approved` / `changes-requested`), `round-comment` (present
  only on rounds where changes were requested), `back-to-submission`

Needs-your-input (`08`):
- `pause-banner` (text: **"Work is paused until you answer."**), `question-thread`,
  `question-text`, `answer-field`, `submit-answer` (button text: **"Send answer"**)

On-hold (`09`, provisional — see Notes):
- `onhold-copy`, `onhold-since`, `onhold-provisional-note`

Shipped (`10`):
- `shipped-copy`, `shipped-link`

Emails (`11`–`13`):
- `email-preview` (`data-email-type` one of `signoff-ready` / `needs-input` / `shipped`),
  `email-from`, `email-to`, `email-subject`, `email-preheader`, `email-body`, `email-cta`

## Customer status vocabulary (pinned, from issue #10)

Fixed, ordered set. `data-status` slug → exact customer-visible text:

| slug | visible text | customer-actionable? | terminal? |
|---|---|---|---|
| `describing` | Describing | no | no |
| `in-design` | In design | no | no |
| `awaiting-signoff` | Awaiting your sign-off | **yes** | no |
| `planned` | Planned | no | no |
| `in-progress` | In progress | no | no |
| `quality-check` | Quality check | no | no |
| `needs-input` | Needs your input | **yes** | no |
| `on-hold` | On hold | no (provisional) | no |
| `shipped` | Shipped | no | **yes** |

Only `Awaiting your sign-off` and `Needs your input` are customer-actionable; only `Shipped` is
terminal. Per issue #14, those three states — and *only* those three — ever generate an email
send. This is a black-box invariant: a test may assert that no other status transition produces
`email-preview` output.

## Design-round / sign-off loop (pinned, from issue #13)

- A design round carries: a plain-language outcome definition, a proposed decomposition (rendered
  as a plain-text list of work items — **no issue numbers, no branch names, no agent identifiers,
  ever**, per issue #16's "They never see a branch, an issue number, or a live agent"), and a mock
  bundle link.
- Rounds are 1-indexed and monotonically increasing per submission. Every previous round stays
  readable at `/submissions/:id/rounds` — a superseded round is never deleted or hidden, only
  marked with its verdict (`changes-requested`, in this contract's vocabulary).
- "Request changes" always opens round *N+1* and returns the submission to `In design`. It never
  mutates round *N* in place.
- "Approve" is the only action that can move a submission past `Awaiting your sign-off` toward
  `Planned`.

## Question channel (pinned, from issue #11)

- A question pauses the submission at `Needs your input` until answered. The mock's copy
  ("Work is paused until you answer.") is a black-box guarantee, not decoration — no other
  customer action should be available on that screen while a question is open.
- Issue #11 states the sign-off loop (#13) is meant to reuse this same raise → pause → resume
  shape, with a verdict attached, rather than parallel it. This contract does not force a single
  shared DOM structure between `08-submission-needs-input.html` and the sign-off screens (`05`,
  `06`) — the visible text and `data-testid`s differ — but a worker collapsing them into one
  component is compatible with this contract as long as each screen's pinned `data-testid`s and
  text still resolve.

## Sync bridge (issue #15) — explicitly not fully pinned

Issue #15 itself states the endpoints are "shape, not final signature": Pull (submissions/sign-offs
since a cursor), Push (pipeline status/design rounds, applied idempotently), Heartbeat. This
contract pins only the constraints the issue commits to, because inventing a concrete path/method
beyond that would be resolving an open question this Gate-A was told not to resolve:
- cursor-based, replay-safe: every request may arrive twice, and the second must be a no-op
- sole-writer per field: the portal owns customer-authored facts (submissions, sign-offs,
  comments, answers); coord owns engineer-authored facts (decomposition, pipeline status,
  questions). A write to a field the receiving side does not own must be rejected, not merged.
- auth is a Cloudflare Access **service token**, scoped to bridge endpoints only.

No screen in `mocks/` renders the sync bridge directly — it has no customer-visible surface. It is
listed here only because `docs/ORACLE_LOOP.md` requires this contract to also pin "API field
shapes" where they exist in the source issues, and this is the one place they do, however loosely.

## Notes — open questions and ambiguities (not resolved by this contract)

1. **On-hold customer visibility is unresolved.** Issue #10 says explicitly: *"Open question
   carried forward: does On hold surface to customers at all? Flagged as the most opinionated
   knob in the vocabulary and still unanswered."* `09-submission-onhold.html` renders the literal
   reading (the word is customer-visible) purely so there is something to react to, and is marked
   `onhold-provisional-note` inside the mock itself. A test-author writing a spec against this
   screen should treat it as **optional/skippable** pending a decision in issue #10, not as a
   required pass condition.
2. **Business-time On-hold threshold (~1 business day, clock pauses nights/weekends/holidays)** is
   specified in issue #10 as a computation rule, not a rendering rule. This contract pins only
   that `onhold-since` carries an ISO-8601 timestamp; it does not pin how or where the "~1
   business day" threshold itself is displayed or computed, since issue #10 does not specify UI
   for it.
3. **Portal-internal API shapes are not specified anywhere in issues #8, #9, #11, #13.** Only the
   sync bridge (#15) discusses request/response shape, and even that is marked non-final. Workers
   implementing `POST /intake`, approve/request-changes, and answer-submission are free to choose
   field names and transport as long as the rendered DOM matches the `data-testid`s and text
   pinned above — the DOM is the contract, not an inferred JSON schema.
4. **How a customer is scoped to "only their own submissions"** (issue #12: "making sure a
   customer can only ever see their own submissions") is stated as a requirement but no session/
   query mechanism is specified. This contract pins the route (`GET /submissions` returns only
   the caller's own) as a black-box behavioural guarantee a test can assert (e.g. via two distinct
   synthetic identities), without pinning how it is implemented.
5. **Static multi-page vs. client-side routing** is not decided by any issue or by `CLAUDE.md`
   beyond "no build step, no framework." This contract pins URL paths and rendered content only;
   it is silent on whether `/submissions/:id` is served as a distinct static response per id or by
   a single shell with client-side routing over `/api/*` data.
6. **Cross-repo numbering.** Issue #16 states the split with `claude-coordinator` is a tool
   constraint, and that customers "never see a branch, an issue number, or a live agent." This
   contract treats that as an absolute: no mock renders any GitHub issue number, PR number, branch
   name, or coord-side identifier anywhere in customer-facing copy. The opaque `SUB-XXXXXX`
   reference used throughout the mocks is a portal-minted id, not a GitHub number, and a test may
   assert its absence rather than assume it's fine either way.

## Synthetic data

All names, submission titles, question text, and design-round content in `mocks/` are invented.
Per `CLAUDE.md`'s first non-negotiable rule ("No customer material in git"), any acceptance spec
written against this contract must also use synthetic fixtures — never real customer text, even
as a "just for testing" convenience.
