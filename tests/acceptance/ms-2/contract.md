# ms-2 — Public Lead Intake v1 — Gate-A contract

Written by an independent mock-author agent from milestone tracking issue **#34** and the
3 open issues filed under it (#31, #32, #33), before and without sight of any implementation.
This is the black-box surface: exact route paths, screen text, `data-testid` hooks and status
vocabulary that the milestone's workers and the independent `test-author` agent must agree on
without a shared session. Mocks are self-contained HTML under `mocks/`, one file per screen
state, styled against the real `public/tokens.css` so they read as the actual product, not a
sketch of it — same convention `tests/acceptance/ms-1/contract.md` established.

Driver: `web-playwright`. Medium: static HTML, no build step, no framework, no live data.

Design of record: `docs/CUSTOMER_PORTAL.md` in `claude-coordinator`. Note for implementers: as
fetched for this Gate A (2026-08-09), that document does not yet mention leads, `/start`,
Turnstile, or an operator surface at all — this milestone is additive to it, not a rendering of
something already specified there. Do not go looking for detail the doc does not have.

This milestone sits on top of ms-1 (issues #9, #10, #12, #13, #11, #15 — the authenticated
customer portal), which is built. Nothing here reopens ms-1's contract; where the two intersect
(see "Interaction with ms-1" below) this document says so explicitly.

## Mock inventory (`mocks/`)

| File | Screen state | Route it represents |
|---|---|---|
| `01-start-form.html` | Empty public lead form | `GET /start` |
| `02-start-receipt.html` | Post-submit receipt with reference | `POST /start`, success (rendered directly, 200 — see note below) |
| `03-start-rejected.html` | Form redisplayed, submission rejected, no lead created | `POST /start`, rejected by the bot gate or rate limit |
| `04-leads-inbox.html` | Operator's list of leads, two states in one screen | `GET /leads` |
| `05-lead-detail.html` | Single lead, not yet promoted, Promote action | `GET /leads/:id`, `data-status="new"` |
| `06-lead-promoted.html` | Same route, after promotion, manual-step instruction | `GET /leads/:id`, `data-status="promoted"` |

## Route surface (pinned)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/start` | **none** | the public lead form |
| `POST` | `/start` | **none** | records a lead, or rejects the write; see below |
| `GET` | `/leads` | operator | list of leads, newest first |
| `GET` | `/leads/:id` | operator | one lead — pre- or post-promotion, a pure function of whether it's been promoted |
| `POST` | `/leads/:id/promote` | operator | promotes the lead; idempotent; redirects to `GET /leads/:id` |

Everything else in this repo (`/intake`, `/submissions`, `/submissions/:id`, `/submissions/:id/rounds`,
`/api/bridge/*`) is ms-1's contract, unchanged.

### `POST /start` does not redirect

Issue #31's Scope section names exactly two routes for the public surface: `GET /start` and
`POST /start` — "That is the whole surface." There is no `GET /start/:id` for a stranger to be
redirected to (unlike `POST /intake`, which 303s to `/submissions/:id` because an authenticated
customer has somewhere durable to land). **`02-start-receipt.html` is the literal response body of
a successful `POST /start`, status 200** (not a redirect target). A worker that redirects to a
new URL here is building a route this contract does not pin and issue #31 does not ask for.

### `POST /start` rejection — two failure families, one rendered shape

Two distinct failure families, both landing on `03-start-rejected.html`'s content:

- **Validation failure** (missing `summary` or `email`): the form is redisplayed with a plain
  "fill in the required fields" style error, status **400**. This mirrors ms-1's `POST /intake`
  pattern exactly (`src/routes/intake.ts`, `submitIntake`).
- **Bot-gate / rate-limit rejection** (issue #32: no token, malformed token, reused token, failed
  `siteverify`, **or** the per-IP rate limit tripped): the form is redisplayed with the banner
  pinned below. **This contract pins one generic message for every one of those reasons** —
  including the rate limit — specifically so the response never confirms *which* check a caller
  tripped. Issue #32 only mandates this for the Turnstile cases ("says so plainly without
  explaining what a valid token would look like"); extending the same non-disclosure to the rate
  limit is this contract's own choice, flagged in Notes below. Suggested status codes: **400** for
  every Turnstile-shaped failure, **429** for the rate limit — but the pinned, testable surface is
  the rendered banner text and the fact that **no lead exists afterward**, not the status code.

**Whichever family fired, no lead is created.** A test may create N leads via valid submissions,
attempt a rejected one, and assert the lead count is still N.

## `data-testid` hooks (pinned)

### Public surface — no Access identity anywhere on these three screens

`01`, `02`, `03` all share:
- `brand-home` in a header that carries **nothing else** — no `nav-dashboard`, no `nav-new`, no
  `identity-email`. Those three are ms-1's authenticated-topbar hooks (`src/render.ts`'s
  `topbar()`); their presence on a public screen would itself be a leak (a stranger would learn
  they're "signed in" as someone, or see nav to a dashboard that isn't theirs).

Form (`01`, and `03` redisplayed):
- `lead-form` (root `<form>`, `method="POST" action="/start"`), `field-lead-summary` (textarea,
  required), `field-lead-email` (`type="email"`, required), `field-lead-name` (text, **optional**),
  `turnstile-widget` (the Cloudflare widget container, carries `data-sitekey`), `submit-lead`
  (button text: **"Send"**)

Receipt (`02`):
- `lead-receipt`, `lead-reference` (text pattern: `Reference LEAD-XXXXXX`), `back-home` (link to
  `/` — the only navigation offered, since there is nothing else a stranger can reach)

Rejected (`03`):
- `lead-error` (`role="alert"`, text: **"We couldn't send that — please try again."**) in addition
  to everything `01` has — same form, same fields, a fresh `turnstile-widget` (Turnstile tokens
  are single-use per issue #32's "a reused token ... fails `siteverify`", so a retry needs a new
  one; testing this does not require asserting the *value* changed, only that the widget container
  is present and the form is intact and resubmittable).

Operator topbar — present on `04`, `05`, `06`, distinct from ms-1's customer topbar:
- `brand-home`, `nav-leads` (`aria-current="page"` on `/leads` and `/leads/:id`), `identity-email`
  (text = `signed in as {operator email}` — same hook name ms-1 uses for the customer topbar, same
  meaning: display copy naming whoever the Access identity resolves to, reused deliberately rather
  than invented fresh so a test author already familiar with ms-1 does not have to learn a second
  name for "who does the page say is signed in").

Leads inbox (`04`):
- `leads-list`, repeated `lead-row` (`data-status` = `new` | `promoted`), each row: `lead-summary`,
  `lead-contact-email`, `lead-submitted-at` (ISO-8601), `lead-status-pill` (`data-status`, text
  **"New"** / **"Promoted"**), `review-lead` (link to `/leads/:id`). Empty state (no mock file —
  pinned here in prose, mirrors `src/routes/dashboard.ts`'s `empty()`): `leads-list-empty`.

Lead detail, both statuses (`05`, `06`):
- root `lead-detail` with `data-status` = `new` | `promoted`, `back-to-leads`, `lead-status-pill`,
  `lead-reference` (text pattern: `LEAD-XXXXXX`), `lead-submitted-at`, `lead-summary-full`,
  `lead-contact-email`, `lead-name` (present only when the optional name was given)

Lead detail, `new` only (`05`):
- `access-seat-reminder` — shown **before** the operator acts, warning that promoting does not
  grant sign-in
- `promote-lead-form` (`method="POST" action="/leads/:id/promote"`), `promote-button` (text:
  **"Promote to submission"**)

Lead detail, `promoted` only (`06`):
- `access-seat-manual-step` (`role="alert"`) — the pinned instruction, shown **after** promotion:
  **"This customer cannot sign in yet. Add {email} to the Access policy by hand to finish
  onboarding them."** This exact requirement — "the promote surface must tell the operator, in the
  flow" — is issue #33's one non-negotiable; a test may treat its absence on a promoted lead's
  detail screen as a failure on its own, independent of anything else on the page.
- `promoted-submission-reference` — **plain text**, not a link. See "Interaction with ms-1" below
  for why this is deliberate, not an oversight.
- No `promote-lead-form` / `promote-button` on this screen — promotion is a one-way transition in
  the UI (the backend's idempotency is what makes a double-click or retry safe, not a second button
  offering to do it again).

## Lead lifecycle (pinned)

Exactly two states, both customer-invisible (a lead has no screen a stranger ever revisits):

| `data-status` | visible text | who can act on it |
|---|---|---|
| `new` | New | operator: promote |
| `promoted` | Promoted | nobody — terminal from the operator UI's point of view |

There is no `declined`, `archived`, or `spam` status in this contract — see Notes.

### Promotion is idempotent (pinned, from issue #33)

`POST /leads/:id/promote` on an already-`promoted` lead must not create a second submission. A
test may promote the same lead twice (or race two concurrent promotes) and assert exactly one
submission exists afterward, both times landing on the same `promoted-submission-reference`.

A lead that is never promoted stays `new` forever — no timeout, no batch job, no auto-promotion.
A test may assert that time passing alone (however it's simulated) never flips `new` to
`promoted`.

## Bot gate + rate limit (pinned, from issue #32)

Documented Cloudflare Turnstile test key pairs — **verified against
`developers.cloudflare.com/turnstile/troubleshooting/testing/`, 2026-08-09** — for driving both
outcomes black-box, with no network dependence on a human solving a challenge:

| Sitekey | Secret | Behavior |
|---|---|---|
| `1x00000000000000000000AA` | `1x0000000000000000000000000000000AA` | always passes |
| `2x00000000000000000000AB` | `2x0000000000000000000000000000000AA` | always fails |

The widget generates a literal token string `XXXX.DUMMY.TOKEN.XXXX` against a test sitekey; a
**production** secret rejects that dummy token, and a **test** secret only accepts it — so an
acceptance run must configure both the sitekey rendered in `01`'s `turnstile-widget` and the
`siteverify` secret to the matching member of one pair, never mixed. This contract pins the two
config surfaces implementers must expose for the acceptance suite to reach: a **public** sitekey
(safe to render, e.g. `TURNSTILE_SITEKEY`) and a **secret**, `wrangler secret put`-only value
(e.g. `TURNSTILE_SECRET`) — exact env/binding names are not pinned beyond "one public, one secret,
both overridable in the local/acceptance environment," since issues #31–#34 do not name them.

**An unset secret must fail closed** (issue #32: "refuse the write ... rather than quietly
accepting every submission"). A test may unset the secret entirely and assert `POST /start`
still creates no lead.

## Operator access (pinned by this contract — not specified in any of #31–#34)

None of the four issues say how the app tells an operator apart from a customer, or from an
anonymous caller. Every other authenticated surface in this repo (ms-1, issue #12) is Cloudflare
Access scoped to "the signed-in customer, and only their own" — a per-identity ownership check,
not a role check, because until now every Access identity *was* a customer. `/leads*` is the first
surface that needs a second kind of identity, and this contract resolves it rather than leaving it
for two independent implementers to guess differently:

- `/leads` and `/leads/:id` and `/leads/:id/promote` read the same Access identity mechanism ms-1
  already built (`src/identity.ts`'s `readAccessIdentity`) — no second login, no portal-side
  session, consistent with CLAUDE.md's "no authentication code in the application."
- The identity's email is checked against a configured operator allowlist (this contract suggests
  a single `OPERATOR_EMAIL` env var; implementers may generalize to a list without breaking this
  contract, since only the black-box behavior below is pinned).
- **No Access identity, or an identity not on that allowlist, gets exactly the same response as a
  not-found lead** — a 404, never a login redirect, never a 403 that confirms `/leads` exists.
  This mirrors ms-1's `isOwnedBy` pattern in `src/routes/submission.ts` exactly (same 404 whether
  the row doesn't exist or the caller doesn't own it) for the same reason: a response that only
  fires for "someone else" would itself leak that the operator surface exists to anyone who found
  the URL.
- A **synthetic customer identity** (one that owns zero or more submissions but is not the
  configured operator) must be rejected from `/leads*` exactly like an anonymous caller. A test may
  reuse one of ms-1's own synthetic customer identities to prove this.

Flagged explicitly because it is this contract's invention, not the issues': the acceptance suite
needs *some* way to mint a synthetic operator identity distinct from a synthetic customer identity.
Whatever mechanism the implementer wires for `OPERATOR_EMAIL` (or its generalization) is what the
test-author must drive — read the implementation's actual env var name rather than assuming this
contract's suggested one shipped unchanged, since only the allowlist *behavior* is pinned here, not
its exact configuration surface.

## Interaction with ms-1 (pinned — a cross-contract consequence, not new scope)

**`promoted-submission-reference` on `06-lead-promoted.html` is plain text, never a link to
`/submissions/:id`.** Reasoning, spelled out because it's easy to miss: ms-1's contract (issue #12)
pins `/submissions/:id` as scoped strictly to `submission.customerEmail === {caller's Access
email}`, returning the same 404 to anyone else — including, necessarily, the operator, whose email
is never the customer's. A worker who adds a clickable link here would ship a link that 404s for
the only person who ever clicks it. A test may promote a lead, then — using the *operator's*
identity — GET the resulting `/submissions/:id` and assert it 404s, proving the two contracts
compose correctly rather than silently reopening #12's scoping.

The submission that promotion creates is otherwise an ordinary ms-1 submission: status
`describing`, owned by the lead's email, visible on that customer's own `/submissions` the moment
they're issued an Access seat and sign in. This milestone adds no new submission fields and no new
status.

## Notes — open questions and ambiguities (not resolved by this contract)

1. **Operator identity mechanism is this contract's own resolution, not the issues'.** See
   "Operator access" above. If a future issue pins a different mechanism (a second Access
   application, say, rather than an allowlisted email), this contract's black-box behavior
   (Access-gated, 404-not-403, same treatment for anonymous and non-operator callers) should still
   hold — only the configuration surface would change.
2. **One generic rejection message covers the rate limit too.** Issue #32 pins non-disclosure only
   for the Turnstile failure modes ("without explaining what a valid token would look like"); this
   contract extends the same generic banner to the rate-limit case as its own choice, on the theory
   that a distinct "you're being rate-limited" message would itself be a disclosure the issue's
   spirit argues against. A worker who ships a distinct, more specific rate-limit message is
   arguably still compliant with issue #32's letter — flagging this as a plausible point of
   divergence between implementer and test-author rather than pretending it's unambiguous.
3. **Whether a minimal decline/dismiss action belongs in v1 is genuinely unclear in issue #33.**
   Its Scope section lists only the promote action; its "Out of scope" line reads "Declining/
   archiving a lead beyond what triage needs" — which could mean *no* decline action ships (the
   literal reading this contract takes: a `new` lead simply sits in the inbox, forever, until
   promoted or never), or could mean some minimal triage-only decline is expected and merely
   "beyond" elaborate archive workflows is excluded. This contract pins **no** decline/dismiss
   `data-testid`, no such route, and no such mock. If a worker builds one anyway, it is additive to
   this contract, not a violation of it — but the test-author should not expect it to exist.
4. **Lead list ordering ("newest first") is inferred, not pinned by any issue.** Issue #33 says
   only "enough of each to decide." A test asserting a specific sort order is asserting this
   contract's inference, which a worker is free to view as under-specified upstream.
5. **The exact wording split between "always" vs "per-attempt" Turnstile widget freshness** is a
   rendering detail this contract does not deeply pin: `03-start-rejected.html` shows a widget
   container present and the form otherwise intact; it does not pin *how* (full page reload vs.
   client-side widget reset) a fresh, unspent token is obtained for the retry, only that the
   contract's `data-testid="turnstile-widget"` hook is present and functional on the redisplay.
6. **`leads` is confirmed as its own table** (issue #31: "`leads` is its own table, not a
   `submissions` row with a flag"; do not edit an existing migration — add a new numbered one).
   This contract does not pin column names or the migration's exact filename (a natural next
   number today is `0004_*.sql`, following `0001`–`0003`, but that is a fact about this repo's
   current state at Gate-A time, not a requirement this contract enforces) — per the ms-1
   contract's established precedent (its note 3), portal-internal schema is implementation, not
   black-box surface, except where an issue explicitly commits to a name the way #31 commits to
   `leads`.
7. **The sync bridge (#15) must never learn about leads** (issue #33: "Coord never sees leads;
   they are pre-pipeline by construction, and the sync bridge must not learn about them"). This is
   a negative, cross-cutting invariant rather than a screen: a test may assert that creating and
   even promoting leads produces no `lead.*`-shaped event on `GET /api/bridge/pull`, and that the
   only bridge-visible trace of a promotion is the ordinary `submission.created` event ms-1's
   contract already pins for `POST /intake` — promotion must produce exactly the same event shape,
   from the daemon's point of view, as if the customer had filled out `/intake` directly.

## Synthetic data

All names, emails, lead text, and reference numbers in `mocks/` are invented, per `CLAUDE.md`'s
"No customer material in git" rule. Any acceptance spec written against this contract must use
synthetic fixtures of its own — never real contact information, even as a "just for testing"
convenience.
