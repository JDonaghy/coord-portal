import { expect, test, type APIRequestContext } from "@playwright/test"

/**
 * ms-2 sealed acceptance slice — issue #41
 * "[portal] The public route ships the whole app's stylesheet — engineer-side
 *  identifiers reach an unauthenticated page, and DOM-level tests structurally
 *  cannot see them"
 *
 * Written from `tests/acceptance/ms-2/contract.md`, the three public mocks it
 * pins (`mocks/01-start-form.html`, `02-start-receipt.html`,
 * `03-start-rejected.html`), ms-1's contract (for the list of hooks that belong
 * to authenticated screens) and issue #41's own Scope/Acceptance sections —
 * without sight of any implementation.
 *
 * WHY THIS SLICE EXISTS AT ALL. #31's slice already asserts "the public surface
 * exposes nothing about submissions, customers, or the fleet", and it passes:
 * it reads `page.locator("body").innerText()`, and a CSS comment, an unused
 * selector, an HTML comment and a blob of inline JSON all render as nothing.
 * The blind spot is the *tier*, not the test. So every assertion below is made
 * against the **raw bytes of the response** — `request.get(...)` / a form POST,
 * never the DOM — because that is the only level at which the property
 * "a stranger receives nothing about the private surface" is expressible.
 *
 * SCOPE, from issue #41:
 *  1. The public route serves only the CSS it needs — no styling for screens a
 *     stranger can never reach.
 *  2. No engineer-side identifier anywhere in a public response body: issue
 *     numbers, PR numbers, branch names, agent names, mock filenames. (ms-1's
 *     contract, note: "no issue numbers, no branch names, no agent identifiers"
 *     in customer-facing material.)
 *  3. `/tokens.css` is fine as-is and stays shared and public.
 *
 * NOT COVERED HERE, deliberately:
 *  - Anything about the *rendered* public surface that #31's slice already
 *    pins. #41's constraint is "do not change #31's rendered surface", so the
 *    hooks and copy are re-asserted here only at the byte level, as a guard
 *    that the clean-up did not take the form with it — the DOM-level pinning
 *    stays #31's job.
 *  - The operator surface and the bot gate (#33, #32). Neither route is public.
 *
 * WHICH RESPONSES COUNT AS "PUBLIC". The contract's route table marks exactly
 * two rows `Auth: none` — `GET /start` and `POST /start` — plus whatever static
 * asset those responses tell a stranger's browser to fetch (a linked
 * stylesheet is served to the same stranger, on the same page load, with the
 * same absence of authentication in front of it). So the sweep below follows
 * the `<link rel="stylesheet">` hrefs out of the response rather than stopping
 * at the HTML — otherwise "move the offending rules into a second sheet" would
 * satisfy the letter of the test while shipping the identical bytes.
 *
 * SYNTHETIC DATA: every email and phrase below is invented, per CLAUDE.md and
 * the contract's "Synthetic data" section.
 */

/* ------------------------------------------------------------------ *
 * The pinned public surface (contract, "`data-testid` hooks", plus the
 * three public mocks). These MUST still be present — #41 forbids changing
 * #31's rendered surface while fixing the leak.
 * ------------------------------------------------------------------ */

/** Hooks on `01-start-form.html` (and, redisplayed, on `03`). */
const PUBLIC_FORM_HOOKS = [
  "brand-home",
  "lead-form",
  "field-lead-summary",
  "field-lead-email",
  "field-lead-name",
  "submit-lead",
]

/** Hooks on `02-start-receipt.html`. */
const PUBLIC_RECEIPT_HOOKS = ["brand-home", "lead-receipt", "lead-reference", "back-home"]

/**
 * Every hook the contract allows on a public screen, including #32's widget and
 * rejection banner and the mock's `async-note`. Kept as documentation of the
 * allowed set; the assertions below deny-list the authenticated hooks rather
 * than allow-listing these.
 * TODO(test-author): an allow-list rule ("no `data-testid` may be referenced on
 * a public screen unless it is one of these") would be strictly stronger, but
 * neither contract forbids an implementation from adding a public hook of its
 * own — `async-note` is itself such an addition, present in the mock and absent
 * from the contract's hook list. Denying the known-authenticated names is the
 * part that is actually derivable, so that is what is asserted.
 */
const PUBLIC_HOOKS = [
  ...PUBLIC_FORM_HOOKS,
  ...PUBLIC_RECEIPT_HOOKS,
  "turnstile-widget",
  "lead-error",
  "async-note",
]
void PUBLIC_HOOKS

/* ------------------------------------------------------------------ *
 * The private surface a stranger must learn nothing about.
 * ------------------------------------------------------------------ */

/** ms-1's pinned hooks — every authenticated customer screen. */
const MS1_HOOKS = [
  "nav-dashboard",
  "nav-new",
  "nav-new-cta",
  "identity-email",
  "intake-form",
  "field-outcome",
  "field-audience",
  "field-done-definition",
  "field-constraints",
  "field-project-scope",
  "submit-intake",
  "intake-receipt",
  "submission-reference",
  "view-submission",
  "back-to-dashboard",
  "submission-list",
  "submission-row",
  "submission-detail",
  "status-pill",
  "status-timeline",
  "timeline-step",
  "rollup-copy",
  "design-round",
  "round-number",
  "round-history-link",
  "round-history",
  "round-entry",
  "round-comment",
  "outcome-definition",
  "decomposition-list",
  "decomposition-item",
  "mock-bundle-link",
  "approve-button",
  "request-changes-button",
  "request-changes-form",
  "changes-comment",
  "next-round-note",
  "cancel-changes",
  "submit-changes",
  "verdict-pill",
  "back-to-submission",
  "pause-banner",
  "question-thread",
  "question-text",
  "answer-field",
  "submit-answer",
  "onhold-copy",
  "onhold-since",
  "onhold-provisional-note",
  "shipped-copy",
  "shipped-link",
  "email-preview",
  "email-from",
  "email-to",
  "email-subject",
  "email-preheader",
  "email-body",
  "email-cta",
]

/** ms-2's own operator hooks (`04`–`06`) — also unreachable by a stranger. */
const OPERATOR_HOOKS = [
  "nav-leads",
  "leads-list",
  "leads-list-empty",
  "lead-row",
  "lead-summary",
  "lead-summary-full",
  "lead-contact-email",
  "lead-submitted-at",
  "lead-status-pill",
  "review-lead",
  "lead-detail",
  "lead-name",
  "back-to-leads",
  "access-seat-reminder",
  "promote-lead-form",
  "promote-button",
  "access-seat-manual-step",
  "promoted-submission-reference",
]

const PRIVATE_HOOKS = [...MS1_HOOKS, ...OPERATOR_HOOKS]

/** ms-1's `data-status` slugs, and ms-2's operator ones. */
const PRIVATE_STATUS_SLUGS = [
  "describing",
  "in-design",
  "awaiting-signoff",
  "planned",
  "in-progress",
  "quality-check",
  "needs-input",
  "on-hold",
  "shipped",
  "promoted",
]

/** Distinctive customer-visible strings from ms-1's status vocabulary. */
const PRIVATE_STATUS_TEXT = [
  "Awaiting your sign-off",
  "Needs your input",
  "Quality check",
  "In design",
  "Work is paused until you answer.",
]

/* ------------------------------------------------------------------ *
 * Scanning helpers. Everything here works on raw response text.
 * ------------------------------------------------------------------ */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** ±70 characters of context, whitespace-collapsed, so a failure is actionable. */
function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 70)
  const end = Math.min(text.length, index + length + 70)
  return `…${text.slice(start, end).replace(/\s+/g, " ").trim()}…`
}

function findAll(text: string, pattern: RegExp, label: string): string[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
  const rx = new RegExp(pattern.source, flags)
  const hits: string[] = []
  for (const match of text.matchAll(rx)) {
    hits.push(`${label} — matched ${JSON.stringify(match[0])} in ${excerpt(text, match.index ?? 0, match[0].length)}`)
  }
  return hits
}

/**
 * CSS hex colours look exactly like `#13`-shaped issue references to a regex.
 * Blank the unambiguous ones (3/4/6/8 hex digits — `#000`, `#1f2937`) before
 * scanning for `#NNN`.
 *
 * TODO(test-author): this necessarily blinds the bare `#NNNN` check to a
 * four-digit issue number (`#1818` is also a valid colour). Neither the issue
 * nor either contract offers a way to tell them apart at the byte level, so
 * such a reference is caught here only when it appears with a word — "issue",
 * "PR", "pull request" — which is how every example in issue #41 is written.
 */
function blankHexColours(body: string): string {
  const blank = (m: string) => "@".repeat(m.length)
  return (
    body
      // Numeric HTML entities (`&#39;`, `&#x27;`) are escaping, not references.
      .replace(/&#x?[0-9a-fA-F]+;/g, blank)
      .replace(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g, blank)
  )
}

/**
 * Issue #41 Acceptance: "no `issue #`-shaped identifier, no PR reference, no
 * branch name, no `mocks/` path".
 */
function engineerIdentifiers(body: string): string[] {
  const withoutColours = blankHexColours(body)
  return [
    ...findAll(body, /\bmocks?\//i, "a mock directory path"),
    ...findAll(body, /\b[\w-]+\.html\b/i, "a mock/source filename"),
    ...findAll(body, /\bcontract\.md\b/i, "a Gate-A contract reference"),
    ...findAll(body, /\bCLAUDE\.md\b/i, "a repo instruction-file reference"),
    ...findAll(body, /\bissues?\s*#?\s*\d+/i, "an issue number"),
    ...findAll(body, /\b(?:pr|pull request)\s*#?\s*\d+/i, "a PR number"),
    ...findAll(body, /\bpull request\b/i, "a PR reference"),
    ...findAll(withoutColours, /#\d+/, "a `#NNN`-shaped identifier"),
    ...findAll(body, /\bbranch\b/i, "a branch reference"),
    ...findAll(body, /\b(?:feat|feature|fix|bugfix|hotfix|chore|wip)\/[a-z0-9._-]+/i, "a branch name"),
    ...findAll(body, /\bclaude\b/i, "an agent/coord-side name"),
    ...findAll(body, /\bsub-?agent\b/i, "an agent name"),
    ...findAll(body, /\bgate[- ]a\b/i, "a coord-side process name"),
    // ms-1 note 6 and #31 both forbid coord-side identifiers in customer-facing
    // material; `coord-portal` itself is the product's own brand (it is the
    // `brand-home` text in `mocks/01`), so it is deliberately not matched here.
  ]
}

/**
 * Issue #41 Scope 1 + Acceptance: "no selector or markup naming an
 * authenticated screen".
 *
 * A hook name counts as leaked when it appears in a position that names a
 * screen element: a `data-testid` attribute or attribute-selector value, or a
 * class/id selector. Boundary-anchored on purpose — `.status-pill` must not
 * match the operator's `.lead-status-pill`, and `data-testid="lead-summary"`
 * must not match the public form's `data-testid="field-lead-summary"`.
 */
function privateSurfaceReferences(body: string): string[] {
  const hits: string[] = []
  for (const hook of PRIVATE_HOOKS) {
    const name = escapeRegExp(hook)
    hits.push(
      ...findAll(body, new RegExp(`data-testid\\s*[=~^$*|]?=\\s*["']${name}["']`), `the ${hook} hook`),
      ...findAll(body, new RegExp(`[.#]${name}(?![\\w-])`), `a selector for ${hook}`),
    )
  }
  for (const slug of PRIVATE_STATUS_SLUGS) {
    hits.push(
      ...findAll(
        body,
        new RegExp(`data-(?:status|step|verdict|round)\\s*[=~^$*|]?=\\s*["']${escapeRegExp(slug)}["']`),
        `a rule for the ${slug} status`,
      ),
    )
  }
  for (const text of PRIVATE_STATUS_TEXT) {
    hits.push(...findAll(body, new RegExp(escapeRegExp(text)), "customer status vocabulary"))
  }
  return hits
}

function report(label: string, violations: string[]): string[] {
  return violations.map((v) => `${label}: ${v}`)
}

/* ------------------------------------------------------------------ *
 * Fetching helpers — raw bytes only, never a DOM.
 * ------------------------------------------------------------------ */

interface Served {
  label: string
  body: string
  /** The shared design-token sheet, which #41 Scope 3 leaves as-is. */
  isTokenSheet: boolean
}

const STYLESHEET_LINK = /<link\b[^>]*rel\s*=\s*["']?stylesheet["']?[^>]*>/gi
const HREF = /href\s*=\s*["']([^"']+)["']/i

/**
 * The HTML at `path`, plus every stylesheet that HTML tells a stranger's
 * browser to download. Following the links is the point: moving the offending
 * rules into a second public sheet would not fix what #41 is about.
 */
async function servedToAStranger(
  request: APIRequestContext,
  path: string,
): Promise<Served[]> {
  const response = await request.get(path, { failOnStatusCode: false })
  expect(response.status(), `${path} must be reachable by a stranger`).toBe(200)
  const html = await response.text()
  const served: Served[] = [{ label: `GET ${path}`, body: html, isTokenSheet: false }]

  for (const link of html.match(STYLESHEET_LINK) ?? []) {
    const href = link.match(HREF)?.[1]
    if (!href || /^(?:https?:)?\/\//i.test(href) || href.startsWith("data:")) continue
    const sheet = await request.get(href, { failOnStatusCode: false })
    expect(
      sheet.status(),
      `${path} links ${href}, so a stranger's browser fetches it — it must be reachable`,
    ).toBe(200)
    served.push({
      label: `${href} (linked from ${path})`,
      body: await sheet.text(),
      isTokenSheet: /tokens\.css(?:$|\?)/i.test(href),
    })
  }
  return served
}

/** A form-encoded `POST /start`, following no redirect, returning raw bytes. */
async function postStart(
  request: APIRequestContext,
  fields: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const response = await request.post("/start", {
    // #32's always-pass test pair mints this literal token (contract, "Bot gate
    // + rate limit"). Before #32 it is an ignored extra field.
    form: { "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX", ...fields },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  return { status: response.status(), body: await response.text() }
}

function expectPinnedHooks(body: string, hooks: string[], label: string) {
  for (const hook of hooks) {
    expect(
      body,
      `${label} must still carry the ${hook} hook — #41 forbids changing #31's rendered surface`,
    ).toContain(`data-testid="${hook}"`)
  }
}

test.describe("ms-2 issue 41 public response body hygiene", () => {
  test("no engineer-side identifier reaches an unauthenticated caller", async ({
    request,
  }) => {
    const served = await servedToAStranger(request, "/start")

    const violations: string[] = []
    for (const { label, body, isTokenSheet } of served) {
      // TODO(test-author): #41 Scope 2 says "no engineer-side identifier
      // appears anywhere in a public response body", while Scope 3 says
      // `/tokens.css` "is fine as-is and stays shared" — and that file's own
      // header comment names the upstream path it was derived from, under a
      // `docs/mocks/` directory. The two clauses cannot both be read
      // literally. The Acceptance section pins the assertion to "the response
      // body of `GET /start`", so that is the reading taken: the identifier
      // sweep exempts the shared token sheet and covers everything else a
      // stranger downloads. If the intent was the stricter reading, this
      // exemption is the line to delete — and `/tokens.css` fails today.
      if (isTokenSheet) continue
      violations.push(...report(label, engineerIdentifiers(body)))
    }

    expect(
      violations,
      [
        "A stranger's fetch of /start must disclose nothing about how the software is built.",
        "This is asserted on the raw response body, not the DOM, precisely because a CSS",
        "comment or an unused selector renders as nothing and the DOM-level tier cannot see it.",
        "",
        ...violations,
      ].join("\n"),
    ).toEqual([])

    // The clean-up must not take #31's form with it.
    expectPinnedHooks(served[0].body, PUBLIC_FORM_HOOKS, "GET /start")
  })

  test("the public route ships no styling for screens a stranger cannot reach", async ({
    request,
  }) => {
    const served = await servedToAStranger(request, "/start")

    const violations: string[] = []
    for (const { label, body } of served) {
      // The token sheet is swept here too: #41 Scope 3 keeps it public *because*
      // it "names no screens", so the same rule applies to it, and moving the
      // application's component rules into it would not be a fix.
      violations.push(...report(label, privateSurfaceReferences(body)))
    }

    expect(
      violations,
      [
        "GET /start must not inherit the authenticated application's stylesheet:",
        "a stranger receives no styling, markup or selector for a screen they cannot reach.",
        "",
        ...violations,
      ].join("\n"),
    ).toEqual([])

    // ...and the form itself is untouched: same hooks, same button copy.
    expectPinnedHooks(served[0].body, PUBLIC_FORM_HOOKS, "GET /start")
    expect(served[0].body, "the Send button's pinned copy is unchanged").toContain("Send")
  })

  test("the shared token sheet stays public and names no screens", async ({ request }) => {
    // #41 Scope 3: "`/tokens.css` is fine as-is and stays shared: it is design
    // tokens, names no screens, and is already public by necessity." So the fix
    // must not privatise it, and must not hide the application's component
    // rules inside it either.
    const response = await request.get("/tokens.css", { failOnStatusCode: false })
    expect(response.status(), "/tokens.css stays public and shared").toBe(200)
    const css = await response.text()

    expect(
      report("/tokens.css", privateSurfaceReferences(css)),
      "the shared token sheet must keep naming no screens",
    ).toEqual([])

    // And /start must actually be styled by something a stranger can fetch —
    // an implementation that "fixes" the leak by serving an unstyled page has
    // changed #31's surface, which #41's constraints forbid.
    const served = await servedToAStranger(request, "/start")
    const hasStyling =
      served.some((s) => s.label !== "GET /start") || /<style\b/i.test(served[0].body)
    expect(hasStyling, "the public form is still styled — by its own CSS, not the app's").toBe(
      true,
    )

    // The public page's own CSS is not the whole application's: the rules it
    // ships are for the public screens. (Checked as "no private selector"
    // rather than as a byte budget — #41 quotes 15125 vs the mock's 4562 but
    // pins no threshold, and a size assertion would be a guess.)
    // TODO(test-author): if a size ceiling is wanted, it has to be pinned in
    // the contract; this slice deliberately does not invent one.
    for (const { label, body } of served) {
      expect(report(label, privateSurfaceReferences(body)), label).toEqual([])
    }
  })

  test("the receipt and the rejected redisplay are as clean as the form", async ({
    request,
  }) => {
    // `POST /start` is the contract's other `Auth: none` row, and it renders
    // two more bodies to strangers: `02-start-receipt.html` on success and
    // `03-start-rejected.html` on refusal. Both are public response bodies, so
    // Scope 2 covers them exactly as it covers the form.
    const summary = "A printable rota for our volunteer drivers (HYGIENE-NONCE)."
    const email = "priya-hygiene@example.test"

    const submitted = await postStart(request, { summary, email, name: "Priya" })
    // The status is deliberately not asserted: whether this POST lands on the
    // receipt (200) or on the rejection depends on which Turnstile key pair the
    // acceptance environment is configured with, which is #32's slice and this
    // contract does not pin. Whatever came back, it went to a stranger.
    const rejected = await postStart(request, { summary })

    const bodies: Array<[string, string]> = [
      [`POST /start (complete, status ${submitted.status})`, submitted.body],
      [`POST /start (incomplete, status ${rejected.status})`, rejected.body],
    ]

    const violations: string[] = []
    for (const [label, body] of bodies) {
      violations.push(...report(label, engineerIdentifiers(body)))
      violations.push(...report(label, privateSurfaceReferences(body)))
    }
    expect(
      violations,
      ["Every public response body — not just the form — must be clean.", "", ...violations].join(
        "\n",
      ),
    ).toEqual([])

    // Neither body loses what #31 and the contract pin for it.
    if (submitted.status === 200 && submitted.body.includes('data-testid="lead-receipt"')) {
      expectPinnedHooks(submitted.body, PUBLIC_RECEIPT_HOOKS, "the receipt")
    } else {
      expectPinnedHooks(submitted.body, PUBLIC_FORM_HOOKS, "the redisplayed form")
    }
    // TODO(test-author): the contract puts validation failures on `03`'s
    // content but describes the copy only as "a plain 'fill in the required
    // fields' style error" without pinning the `lead-error` banner for that
    // family — so only the redisplayed form is asserted here, never the wording.
    expectPinnedHooks(rejected.body, PUBLIC_FORM_HOOKS, "the redisplayed form")
  })
})
