# ms-4 — Client identity + lead-promotion linking — Gate-A contract

Written by an independent mock-author agent from milestone tracking issue **#122** and the
5 open issues filed under it (#128, #129, #130, #131, #132), before and without sight of any
implementation. This is the black-box surface: exact route paths, screen text, `data-testid`
hooks and status vocabulary that the milestone's workers and the independent `test-author` agent
must agree on without a shared session. Mocks are self-contained HTML under `mocks/`, one file
per screen state, styled against the real `public/tokens.css` — same convention `ms-1` and `ms-2`
established.

Driver: `web-playwright`. Medium: static HTML, no build step, no framework, no live data.

This milestone sits on top of ms-1 (the authenticated customer portal) and ms-2 (public lead
intake + operator promotion, `tests/acceptance/ms-2/contract.md`), both built. Nothing here
reopens either contract; every extension to an ms-2 screen is called out explicitly below, and
every hook ms-2 already pins (`lead-detail`, `lead-status-pill`, `promote-lead-form`,
`access-seat-reminder`, `access-seat-manual-step`, `promoted-submission-reference`, and so on)
keeps exactly its ms-2 meaning and rendering. This contract only adds to that surface.

## What this milestone actually touches, and what it does not

Five open issues, four of which change something a browser can see:

- **#128 — `clients` table + `projects.client_id`.** Schema only, no route, no UI. Pinned here
  only as background: `clients(id, email UNIQUE, phone, cc_emails, address, created_at)`, no
  backfill of existing rows, no FK. No mock for this issue — there is nothing to render.
- **#129 — lead promotion detects/links a client.** Changes `/leads/:id` (both before and after
  promotion). Mocks 01–03.
- **#130 — reassign a submission to a different project.** New action reachable from the same
  promoted-lead screen. Mocks 02, 04, 05.
- **#131 — client self-service profile page.** New route, `/account`. Mock 06.
- **#132 — operator "start work" override.** New action, also reachable from the promoted-lead
  screen. Mocks 02–05.

## Mock inventory (`mocks/`)

| File | Screen state | Route it represents |
|---|---|---|
| `01-lead-detail-client-match.html` | Unpromoted lead, email matches an existing client | `GET /leads/:id`, `data-status="new"`, match found |
| `02-lead-promoted-existing-client.html` | Just promoted, attached to the matched client's existing project | `GET /leads/:id`, `data-status="promoted"`, `data-match="existing"`, submission still `describing` |
| `03-lead-promoted-new-client.html` | Just promoted, no match — new client + "Project 1" auto-created | `GET /leads/:id`, `data-status="promoted"`, `data-match="new"`, submission still `describing` |
| `04-lead-promoted-work-started.html` | Same lead as 02, after the operator used "Start work" | `GET /leads/:id`, `data-status="promoted"`, attached submission now `planned` |
| `05-lead-reassign-open.html` | Same lead as 02, reassignment panel expanded | `GET /leads/:id`, `data-status="promoted"`, `reassign-toggle` checked |
| `06-account-profile.html` | Signed-in client editing their own profile | `GET /account` |

**Not re-rendered, described in prose instead:** `GET /leads/:id`, `data-status="new"`, **no**
client match. This is byte-identical to `tests/acceptance/ms-2/mocks/05-lead-detail.html` —
`client-match-card` (mock 01's new section) simply does not render when `getClientByEmail`
finds nothing. Nothing else on that screen changes; there is no equivalent of mock 01's fieldset
to show in its absence, and no new copy is pinned for "we didn't find anyone" pre-promotion (the
no-match outcome is only announced *after* promotion — mock 03's `client-attachment`).

## Route surface (pinned)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/leads/:id` | operator | **unchanged path**, richer body — see below |
| `POST` | `/leads/:id/promote` | operator | **unchanged path**, now reads `projectChoice` from the form — see "Lead promotion" |
| `POST` | `/leads/:id/reassign` | operator | **new** (#130) — moves the attached submission to a different project of the same client, or creates one |
| `POST` | `/leads/:id/start-work` | operator | **new** (#132) — the sign-off-skipping override |
| `GET` | `/account` | customer | **new** (#131) — the signed-in client's own profile |
| `POST` | `/account` | customer | **new** (#131) — saves phone / cc emails / address |

Every other route in this repo (`/intake`, `/submissions*`, `/projects/:id`, `/start`, `/leads`,
`/deliveries`, `/outbox`, `/api/bridge/*`) is unchanged by this milestone.

`/leads/:id/reassign` and `/leads/:id/start-work` sit next to `/leads/:id/promote` and
`/leads/:id/message` in `src/routes/leads.ts`'s existing routing table (`matchLeadsPath`) — same
file, same operator gate (`readOperator`), same "any other method on a `/leads…` path gets the
lead-not-found 404" rule ms-2's contract already pins. Neither is a new top-level surface.

### Why these two actions live on `/leads/:id` and not somewhere new

Neither #130 nor #132 names a route. `/leads/:id` is, today, the *only* screen an operator ever
reaches a specific submission from by more than a plain-text reference
(`promoted-submission-reference` — ms-2's contract, "plain text, never a link" — is exactly the
reason a richer operator view of that submission has to live somewhere, and this is the somewhere
this contract picks). This is this contract's own architectural resolution, not mandated by
either issue — flagged, the same way ms-2's contract flagged its own resolution of "how does the
app tell an operator apart from a customer" (its § "Operator access"). See Notes 4 and 5 below for
the scope gap this leaves.

## Lead promotion, extended (#129)

### Before promotion — client match (mock 01)

`GET /leads/:id`, `data-status="new"`. When `lead.email` matches an existing `clients.email`
row (case handling unspecified by #128/#129 — this contract assumes the same case-insensitive
treatment `src/operators.ts` already uses for its own email comparison, flagged as an inference in
Notes below), a new section renders between the lead's own facts and the seat reminder:

- `client-match-card` (`data-match="existing"`)
- `client-match-email` — the matched client's email, verbatim
- `client-match-project-count` — how many projects that client already has
- `client-project-list` — a `<fieldset>` of radio inputs, `name="projectChoice"`, one
  `client-project-option` (`data-project-id`) per existing project **plus** one
  `client-project-option-new` (`value="new"`). The newest/most-recent project is pre-selected.
- Submitted as part of the same `promote-lead-form` (`method="POST" action="/leads/:id/promote"`)
  — one POST, no separate confirmation step. `promote-button`'s text is unchanged ("Promote to
  submission").

No client match: this screen is unchanged from ms-2's `05-lead-detail.html` — see "Not
re-rendered" above.

### After promotion (mocks 02, 03)

`GET /leads/:id`, `data-status="promoted"`. Every ms-2 hook (`access-seat-manual-step`,
`promoted-submission-reference`, `lead-summary-full`, `lead-contact-email`, `lead-name`) renders
exactly as ms-2 pins it. New:

- `client-attachment` — the sentence #129 explicitly requires ("the rendered response after
  promotion says the work is attached to the existing client, not just 'submission created'").
  `data-match="existing"` (mock 02) or `data-match="new"` (mock 03). Text is not pinned verbatim
  beyond: it must name the client's email and, for a match, the project it joined; for no-match,
  that a new client was created. Mocks 02/03 show this contract's suggested copy — a worker's
  wording is compliant as long as those facts are present in the rendered text.
- `attached-submission-status` — a `.status-pill`-shaped element, `data-status` = the attached
  submission's current customer-facing status (`describing` at first; see "Start work" below for
  when it becomes `planned`). This is new: ms-2's contract never rendered the submission's own
  status on this screen, only its reference.

### Which projects are even offered

`client-project-list` / `reassign-project-list` (below) are built from `SELECT * FROM projects
WHERE client_id = ?` — **only** projects that already carry the matched `clients.id` in
`client_id`. A project created before this milestone, or via a customer's own "Start a follow-up"
action (`src/routes/submission.ts`, issue #109), shares the client's `customer_email` but has
`client_id IS NULL` (#128: no backfill, no inference from a matching email) and will **not**
appear in either list. A test may create such a project and assert it is absent from both.

## Reassignment (#130) — mocks 02, 04, 05

Present on every `data-status="promoted"` rendering of `/leads/:id`, closed by default:

- `reassign-toggle` — a real, focusable checkbox, visually hidden (same technique
  `src/render.ts`'s `.composer-toggle` already uses for the design-round request-changes
  composer — no JavaScript, `role="button"` labels toggle it by click, the checkbox itself is the
  keyboard's tab stop). Mocks 02–04 render it unchecked; mock 05 renders it checked.
- `reassign-open-button` (`role="button"`, `for="reassign-toggle"`, text "Reassign project")
- `reassign-form` (`method="POST" action="/leads/:id/reassign"`), revealed while the toggle is
  checked (mock 05):
  - `reassign-current-project` — the submission's current project, by name
  - `reassign-project-list` — every **other** project belonging to the same client
    (`client_id` match, current project excluded) as `reassign-project-option` radios, plus
    `reassign-project-option-new` ("Start a new project instead")
  - `reassign-cancel` (`role="button"`, closes the panel without submitting)
  - `reassign-submit` (button, text "Move to this project")

**Scoped to the same client, per #130's own wording** ("reassignment within one client's own
projects... moving a submission to a different client entirely is out of scope"). There is no
control anywhere in this contract for changing which client a submission belongs to.

A client with only one project (mock 03's raf@example.test, whose only project is the
auto-created "Project 1") still renders `reassign-open-button` — opening it shows
`reassign-project-list` with **no** `reassign-project-option` (nothing to move to) and only
`reassign-project-option-new`. This contract does not pin whether that empty state additionally
shows explanatory copy; a worker is free to add it.

**Available "not just at promotion time"** (#130): mock 04 shows the identical
`reassign-open-button` on a lead that was promoted, then had `start-work` used on it, days later
from the operator's point of view — reassignment does not depend on, or get consumed by, the
start-work action.

## The operator "start work" override (#132) — mocks 02–05

Rendered only while the attached submission's status has not yet been moved forward by this
action (i.e., `attached-submission-status` is not already `planned`):

- `start-work-card`, containing `start-work-note` (explanatory copy — not pinned verbatim beyond
  conveying "skips sign-off, moves to Planned, only for pre-agreed work") and `start-work-form`
  (`method="POST" action="/leads/:id/start-work"`) with `start-work-button` (text "Start work").

After use (mock 04): `start-work-card` is gone entirely — same one-way-in-the-UI convention
`promote-lead-form`'s disappearance after promotion already establishes (ms-2's contract: "the
backend's idempotency is what makes a double-click or retry safe... not a second button"), and
`attached-submission-status` reads `data-status="planned"`.

### What "planned" means here, precisely — and what it does not

`src/submissions.ts` is explicit and repeatedly documented that `submissions.status` is
**coord-owned**: "there is no portal code path that writes it." This contract does not ask
implementers to violate that invariant. What "Start work" is pinned to produce is the exact same
kind of thing an **approved design round** already produces today: `derivedStatus`
(`src/rounds.ts`) computes a customer-visible `planned` the instant a customer approves, purely
client-side of the coordinator, before the daemon has pushed anything back to the `status`
column. "Start work" is this contract's operator-side equivalent of that same derived read — the
`attached-submission-status` pill, and the customer's own `/submissions/:id` (rendered by ms-1's
existing, unmodified rollup template, `data-status="planned"`), both read "Planned" immediately
after the operator acts, by the same derivation mechanism, not because a new portal code path
started writing `submissions.status` directly. **How** the operator's decision is recorded (a new
table alongside `design_rounds` and `previewReviews`? a `coord_facts`-shaped row? something else)
is implementation, not pinned by this contract.

This is deliberately the one point in this contract where the visible, testable outcome (the pill
reads "Planned", `/submissions/:id` reads "Planned") is pinned firmly, while the mechanism
producing it is pinned only by analogy to an existing pattern — because the alternative would be
inventing a schema decision that isn't this contract's job to make.

### What is NOT resolved here: which bridge event fires

Issue #132's own text sets up a choice — reuse `signoff.approved`'s shape, or define a new
`BRIDGE_EVENT_TYPES` member — and says "pick one and document the choice here." **The copy of
issue #132 this contract was authored against was truncated mid-sentence inside its own decision
section**, cutting off before naming which option it picked, and before showing option 2's text
at all. This contract does not guess. Nothing here pins a specific `type` value on
`GET /api/bridge/pull`'s output for a "start work" submission — only the customer/operator-visible
consequence above. **Implementers must resolve this against issue #132's actual, complete text,
not against this contract, which never saw enough of it to make that call responsibly.** If a
sealed acceptance test needs to assert on the bridge event shape, its author faces the identical
gap and should flag it rather than invent an answer either.

## Client self-service profile (#131) — mock 06

`GET /account`, behind the same customer Access application ms-1's `/submissions*` already sits
behind (`resolveSiteIdentity` — same identity mechanism, no new auth code, per CLAUDE.md and
#131's own wording). Adds one nav entry to the existing customer `topbar()`
(`src/render.ts`): `nav-account` (text "My profile"), additive the same way issue #14 added
`nav-outbox` — every other `topbar()` hook (`brand-home`, `nav-dashboard`, `nav-new`,
`nav-outbox`, `identity-email`) is unchanged.

- `account-form` (`method="POST" action="/account"`)
- `account-email` — `<input readonly>`, the caller's own Access email, never editable here
  (#131: "Email stays read-only... it's the Access identity, not an editable field")
- `account-phone-field` (`name="phone"`, optional)
- `account-cc-emails-field` (`name="ccEmails"`, optional, comma-separated per `clients.cc_emails`'s
  own column comment in #128: `"comma-separated; revisit as a join table only if a real need
  shows up"`)
- `account-address-field` (`name="address"`, optional, multi-line)
- `account-save-button`

No dedicated "saved" mock: per this repo's established PRG convention (every other form in this
portal 303s back to a GET of itself — `submitSubmissionAction`, `promoteLeadAction`, `submitStart`
all follow it), `POST /account` redirecting to `GET /account` with the new values already
reflected in the same fields is the pinned behavior; no distinct confirmation banner is pinned by
this contract (a worker may add one additively, the same latitude ms-2's contract left for its
own unpinned surfaces).

### A gap #131 leaves open, resolved here (flagged, not mandated)

#131 assumes "a signed-in client can view and edit **their own `clients` row**" — but #129 is the
only path that ever creates a `clients` row, and it only fires on lead promotion. A customer who
signed up before this milestone, or who has only ever used `/intake` directly, has no `clients`
row at all. If `GET /account` 404'd for that customer, the self-service feature #131 asks for
would be unusable for exactly the population most likely to want it. This contract resolves that
gap the same way it resolves other unspecified plumbing: `GET /account` renders the form with
every optional field blank (only `account-email` pre-filled) when no `clients` row exists yet, and
`POST /account` creates one on first save rather than requiring it to already exist. This is this
contract's own invention — #131's text does not say this — flagged so an implementer who reads
the issue and reasonably reaches a different conclusion (e.g., "no clients row → 404, matching
every other ownership-scoped route in this codebase") knows this contract chose the other reading
on purpose, not by oversight.

## The "Project 1" title — a contradiction this contract does not resolve

#129 asks for a project "titled 'Project 1' (renamable later — no rename UI required by this
issue)". But `migrations/0012_projects.sql` — already shipped, unchanged by #128 — is explicit and
deliberate that `projects` has **no title column**: "a project has no state of its own to store;
everything it shows is derived from the submissions under it." #128 (this milestone's own schema
issue) adds `client_id` and nothing else to `projects`. There is nowhere in the schema this
milestone touches to durably store the string "Project 1", and therefore nothing for a later
"rename" to act on even if one were built.

This contract does not invent a title column — that is a schema decision for #128 or a follow-up
issue, not something a mock-author should decide unilaterally. What it pins instead, consistent
with the existing derivation convention (`titleOf` in `src/submissions.ts`, already reused by both
the dashboard and `/projects/:id`):

- A project **with at least one submission** displays exactly what every other project already
  displays today — the newest submission's own derived title (`titleOf`). Mocks 01 and 05's
  "Storefront refresh" and "Onboarding emails cleanup" are both submission-derived titles, not
  stored project titles.
- A project with **zero** submissions — which only ever happens transiently, for the moment
  between "operator picks 'create a new project' on the reassignment or promotion form" and "the
  submission that triggered it actually lands" — has nothing to derive a title from. This contract
  pins a positional placeholder for that one moment only: "Project 1", "Project 2", … (a count of
  that client's existing projects, plus one) — which is what mock 03's "Project 1" actually is:
  the *auto-created* project's label at the exact instant it is created alongside the promoted
  submission, before that submission's own outcome text becomes available to derive from. The
  moment a real submission is attached, display reverts to the ordinary derived-title convention,
  and the "Project 1" string is never seen again — it was never stored anywhere durable to begin
  with.

A worker who adds a real, stored, renamable project title is not violating this contract, but is
also not implementing anything #128 scopes — flagged as a plausible, reasonable point of
divergence between what #129's prose literally asks for and what this milestone's own schema
issue provides for.

## `data-testid` hooks — full list, new-in-ms-4 only

(Everything ms-2's contract already pins on `/leads*` — `lead-detail`, `back-to-leads`,
`lead-status-pill`, `lead-reference`, `lead-submitted-at`, `lead-summary-full`,
`lead-contact-email`, `lead-name`, `access-seat-reminder`, `access-seat-manual-step`,
`promoted-submission-reference`, `promote-lead-form`, `promote-button` — is unchanged and not
repeated here.)

**`/leads/:id`, before promotion, client match (mock 01):**
`client-match-card` (`data-match`), `client-match-email`, `client-match-project-count`,
`client-project-list`, `client-project-option` (repeated, `data-project-id`),
`client-project-option-new`

**`/leads/:id`, after promotion (mocks 02–05):**
`client-attachment` (`data-match`), `attached-submission-status` (`data-status`),
`start-work-card`, `start-work-note`, `start-work-form`, `start-work-button`,
`reassign-toggle`, `reassign-open-button`, `reassign-form`, `reassign-current-project`,
`reassign-project-list`, `reassign-project-option` (repeated, `data-project-id`),
`reassign-project-option-new`, `reassign-cancel`, `reassign-submit`

**`/account` (mock 06):**
`nav-account` (on the shared customer `topbar()`), `account-form`, `account-email`,
`account-phone-field`, `account-cc-emails-field`, `account-address-field`, `account-save-button`

## Synthetic data

Every name, email, lead summary, project title and reference in `mocks/` is invented, per
CLAUDE.md's "No customer material in git" rule — `dana@example.test`, `raf@example.test` and
`ops@example.test` all sit on RFC 6761's reserved `.test` TLD, the same domain ms-2's contract and
`src/operators.ts`'s `DEV_OPERATOR_EMAIL` already use, specifically because it can never resolve
to a real mailbox. Any acceptance spec written against this contract must use synthetic fixtures
of its own — never real contact information.

## Notes — open questions and ambiguities (not resolved by this contract)

1. **#132's event-kind decision was unreadable at Gate-A time** — see "What is NOT resolved here"
   above. This is the single most consequential gap in this contract: it affects what a sealed
   acceptance test can assert about `GET /api/bridge/pull` for a "start work" submission, and this
   contract deliberately does not guess.
2. **The "Project 1" title has nowhere durable to live**, per the dedicated section above — a
   real contradiction between #129's prose and #128's (and 0012's) schema, not a rendering detail.
3. **Case sensitivity of the client email match** (#129's "looks up `clients` by the lead's
   email") is not specified by #128 or #129. This contract assumes case-insensitive matching, by
   analogy with `src/operators.ts`'s own allowlist comparison — that code's rationale is that no
   identity provider treats the local part as case-sensitive *in practice*, i.e. matching should be
   case-insensitive — flagged as an inference, not a quote from either issue.
4. **No operator entry point exists, in this contract, for a submission that never went through
   `/leads`.** Every screen this contract adds hangs off `/leads/:id`. A submission a customer
   created via their own "Start a follow-up" action (issue #109), or one that predates this
   milestone entirely, has no `client_id`-linked project (#128: no backfill) and no lead to view it
   through — so it is reachable by neither the reassignment control nor the start-work override
   this contract pins. Neither #130 nor #132 names a route that would fix this. Flagged as an open
   scope question for a future issue, not resolved here.
5. **The corollary of note 4**: a `clients` row with projects that were never touched by a lead
   promotion (say, a client who also has an old follow-up project with `client_id IS NULL`) will
   show an incomplete project list on every screen this contract pins — "only projects that
   already carry this client's id" is a precise, testable rule, but it is not the same thing as
   "everything this client actually has with us," and this contract does not claim otherwise.
6. **Whether `POST /leads/:id/reassign` needs its own idempotency guard**, the way
   `POST /leads/:id/promote` is keyed on `promoted_at IS NULL` (0007's whole design), is not
   addressed by #130. A double-submitted reassignment landing twice is presumably harmless (moving
   a submission to project X twice is still just "at project X"), but this contract does not pin
   that as a guarantee — a worker who adds a guard anyway is not violating anything here.
