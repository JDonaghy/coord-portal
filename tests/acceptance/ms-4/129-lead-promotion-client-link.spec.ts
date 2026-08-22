import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test"

/**
 * ms-4 sealed acceptance slice — issue #129
 * "Lead promotion: detect + link existing client, default-create client +
 *  Project 1 for new emails"
 *
 * Written from `tests/acceptance/ms-4/contract.md` and the three mocks it pins
 * for this issue (`mocks/01-lead-detail-client-match.html`,
 * `02-lead-promoted-existing-client.html`,
 * `03-lead-promoted-new-client.html`), without sight of any implementation.
 *
 * ── WHAT #129 ACTUALLY PROMISES, AND WHAT IS ASSERTED FOR IT ────────────────
 *
 *  1. **Match found, before the operator commits** (contract § "Before
 *     promotion — client match", mock 01): `client-match-card`,
 *     `client-match-email`, `client-match-project-count`, and a
 *     `client-project-list` of `name="projectChoice"` radios — one
 *     `client-project-option` per project the client already has, plus
 *     `client-project-option-new` (`value="new"`), newest pre-selected.
 *  2. **No match, before promotion**: the screen is unchanged from ms-2's
 *     `05-lead-detail.html` — contract § "Not re-rendered": the card "simply
 *     does not render when `getClientByEmail` finds nothing". Asserted as a
 *     CONTROL (see below).
 *  3. **After promotion, either branch** (contract § "After promotion", mocks
 *     02/03): `client-attachment` with `data-match="existing"` / `"new"` — the
 *     sentence the issue calls out by name, because "a real customer's
 *     follow-up lead was promoted with zero indication it belonged to someone
 *     the operator had already worked with" — plus
 *     `attached-submission-status`.
 *  4. **No match ⇒ auto-create**: a `clients` row with the email *and nothing
 *     else* ("email only, no phone/cc/address"), a project alongside it, and
 *     the new submission attached to that project, all in the same batch.
 *  5. **Still inside 0007's idempotency guard**: "a double-click or retry still
 *     converges on one submission (and does not double-create a client)".
 *  6. **Which projects are even offered** (contract § of that name): only
 *     projects that already carry the matched `clients.id`. A project created
 *     by a customer's own follow-up (#109) has `client_id IS NULL` and "will
 *     **not** appear in either list" — the contract says outright that "a test
 *     may create such a project and assert it is absent".
 *
 * ── WHAT THIS SLICE DELIBERATELY DOES NOT ASSERT ────────────────────────────
 *
 *  - **`reassign-*` (#130), `start-work-*` (#132), `/account` (#131).** Other
 *    issues' slices own those, even though mocks 02/03 render them on the same
 *    screen. The one exception is `attached-submission-status`, which the
 *    contract introduces inside its own **#129** section ("After promotion") as
 *    part of what promotion now renders; it is asserted here in a single
 *    dedicated test, at its `describing` value only, so that if the milestone
 *    decides that hook belongs to #132 after all, exactly one test moves.
 *  - **`clients`' shape, indexes, FK-lessness, no-backfill** — #128's slice
 *    (`128-clients-schema.spec.ts`) owns all of that. This slice reads the
 *    table only to check what #129 *writes* into it.
 *  - **The project's displayed title.** Contract § "The 'Project 1' title — a
 *    contradiction this contract does not resolve" is explicit that there is
 *    nowhere in this milestone's schema to store one, that "Project 1" is a
 *    positional placeholder for a single transient moment, and that a project
 *    with submissions shows a *derived* title instead. See the TODO on
 *    `client-attachment` below.
 *  - **Anything about the bridge.** #129 changes no event shape, and the
 *    contract pins none for this issue.
 *
 * ── HOW ROWS GET CREATED ────────────────────────────────────────────────────
 *
 * Only through the real HTTP surface, the way `ms-2/33-lead-triage-promotion`
 * and `ms-4/128-clients-schema` already do it: `POST /start` for leads,
 * `POST /intake` for submissions, the operator's own `/leads/:id` screen for
 * promotion. Nothing is injected into D1 — CLAUDE.md's determinism rule cuts
 * both ways in a single-worker suite with no retries.
 *
 * D1 is read (never written) for the handful of facts #129 states as *data*
 * rather than as rendering: "a `clients` row (email only, no phone/cc/address)",
 * "does not double-create a client", and which project the new submission was
 * actually attached to. Same read-only `wrangler d1 execute --local` channel
 * `128-clients-schema.spec.ts` established, against the same migrated database
 * `serve:acceptance` built.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every email, name and summary below is invented and sits on RFC
 * 6761's reserved `.test` TLD.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/**
 * The operator identity — same value, same escape hatch and same caveat as
 * `tests/acceptance/ms-2/33-lead-triage-promotion.spec.ts`. ms-2's contract
 * pins only the *behaviour* of the operator allowlist, not the env var, and a
 * sealed slice cannot read the implementation to find out which one shipped.
 * `ops@example.test` is what every operator mock in ms-2 and ms-4 renders in
 * `identity-email`.
 */
const OPERATOR_EMAIL = process.env.COORD_PORTAL_OPERATOR_EMAIL ?? "ops@example.test"

/** ms-2 contract: `lead-reference` text pattern. */
const LEAD_REFERENCE = /LEAD-[A-Z0-9]{6}/
/** ms-1's customer-visible submission reference, which promotion mints one of. */
const SUBMISSION_REFERENCE = /SUB-[A-Z0-9]{6}/

/**
 * ms-2 contract, "Bot gate + rate limit": the literal token a Turnstile **test**
 * sitekey mints. `POST /start` is used here purely as an instrument for getting
 * a lead into the inbox, so the token is sent directly rather than waiting for
 * the widget to mint it in a browser.
 *
 * TODO(test-author): if seeding starts failing with "no receipt", the bot gate
 * or the per-IP rate limit is the first thing to look at, not this slice's
 * logic — ms-2's contract pins neither threshold nor window, so the number of
 * leads a single acceptance run may seed from one address is unknown. This file
 * seeds one to three per test.
 */
const TURNSTILE_FIELD = "cf-turnstile-response"
const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"

// Several tests shell out to wrangler (~1.5s a call) on top of their HTTP and
// browser work. The 30s default leaves too little headroom.
test.describe.configure({ timeout: 150_000 })

// ── the migrated database, read-only ────────────────────────────────────────

/** Mirrors `repoRoot()` in `128-clients-schema.spec.ts`. */
function repoRoot(): string {
  let dir = process.cwd()
  for (let hops = 0; hops < 8; hops++) {
    if (existsSync(join(dir, "wrangler.toml")) && existsSync(join(dir, "package.json"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    "could not locate the repo root (no wrangler.toml + package.json) walking up from " +
      `${process.cwd()} — this slice reads the migrated local D1 for the few facts #129 ` +
      "states as data rather than as rendering",
  )
}

interface D1Query {
  ok: boolean
  rows: Record<string, unknown>[]
  error: string | null
}

/** Ask the migrated local D1 a read-only question. Never writes. */
function d1(sql: string): D1Query {
  const root = repoRoot()
  const local = join(root, "node_modules", ".bin", "wrangler")
  const [cmd, lead] = existsSync(local) ? [local, [] as string[]] : ["npx", ["wrangler"]]
  const args = [...lead, "d1", "execute", "coord-portal", "--local", "--json", "--command", sql]

  let stdout: string
  try {
    stdout = execFileSync(cmd, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    })
  } catch (err) {
    // wrangler exits non-zero on a SQL error but still reports it as JSON on
    // stdout — that is a result to assert on, not a crash to rethrow.
    stdout = String((err as { stdout?: string }).stdout ?? "")
    if (!stdout.trim()) {
      const stderr = String((err as { stderr?: string }).stderr ?? "").trim()
      throw new Error(`wrangler d1 execute produced no output for ${sql}\n${stderr}`)
    }
  }

  const start = stdout.search(/[[{]/)
  if (start < 0) throw new Error(`could not find JSON in wrangler's output for ${sql}\n${stdout}`)
  const parsed = JSON.parse(stdout.slice(start)) as unknown

  if (Array.isArray(parsed)) {
    const first = parsed[0] as { results?: Record<string, unknown>[] } | undefined
    return { ok: true, rows: first?.results ?? [], error: null }
  }
  const failure = parsed as { error?: { text?: string } }
  return { ok: false, rows: [], error: failure.error?.text ?? JSON.stringify(parsed) }
}

/** SQL string literal. Every value here is synthetic and generated by this file. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Every `clients` row for an address, compared case-insensitively.
 *
 * TODO(test-author): the case-insensitive comparison is the contract's own
 * inference (Note 3: "#128 or #129 [do not specify]... this contract assumes
 * case-insensitive matching, by analogy with `src/operators.ts`"). Reading with
 * `lower()` here is deliberately the *looser* of the two readings, so this
 * helper never manufactures a duplicate-row failure out of a casing difference.
 */
function clientRows(email: string): Record<string, unknown>[] {
  const q = d1(
    `SELECT id, email, phone, cc_emails, address FROM clients WHERE lower(email) = lower(${quote(email)})`,
  )
  expect(
    q.ok,
    `reading \`clients\` should succeed — #128 landed the table this issue writes into. SQLite said: ${q.error}`,
  ).toBe(true)
  return q.rows
}

/** The project ids carrying a given `clients.id`, oldest first. */
function projectIdsFor(clientId: string): string[] {
  const q = d1(
    `SELECT id FROM projects WHERE client_id = ${quote(clientId)} ORDER BY created_at, id`,
  )
  expect(q.ok, `reading \`projects\` should succeed. SQLite said: ${q.error}`).toBe(true)
  return q.rows.map((r) => String(r.id))
}

/** The `projects.id` a promoted submission ended up attached to, by its SUB- reference. */
function projectOfSubmission(reference: string): string | null {
  const q = d1(`SELECT project_id FROM submissions WHERE reference = ${quote(reference)}`)
  expect(q.ok, `reading \`submissions\` should succeed. SQLite said: ${q.error}`).toBe(true)
  expect(q.rows.length, `exactly one submission should carry the reference ${reference}`).toBe(1)
  const value = q.rows[0].project_id
  return value == null ? null : String(value)
}

// ── identities ──────────────────────────────────────────────────────────────

function withIdentity(
  browser: Browser,
  baseURL: string | undefined,
  email: string,
): Promise<BrowserContext> {
  return browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: email } })
}

function asOperator(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return withIdentity(browser, baseURL, OPERATOR_EMAIL)
}

// ── seeding, through the pinned public surfaces ─────────────────────────────

interface SeededLead {
  summary: string
  email: string
  reference: string
}

/** A synthetic lead, distinct per test and per position within a test. */
function leadSummary(tag: string, nth: number): string {
  return (
    `A shared allotment watering rota (${tag.toUpperCase()}-129-${nth}) — right now it lives ` +
    `on a whiteboard and nobody off-site can read it.`
  )
}

/**
 * Create one lead the way a stranger does, straight through `POST /start`.
 *
 * Nothing about that screen is asserted — #31 owns it. This is the only way a
 * lead can come into existence black-box.
 */
async function seedLead(
  request: APIRequestContext,
  email: string,
  summary: string,
  name?: string,
): Promise<SeededLead> {
  const form: Record<string, string> = {
    summary,
    email,
    [TURNSTILE_FIELD]: TURNSTILE_DUMMY_TOKEN,
  }
  if (name !== undefined) form.name = name

  const res = await request.post("/start", { form, failOnStatusCode: false })
  const body = await res.text()
  expect(
    body,
    "seeding a lead needs POST /start to render its receipt (#31); if this is failing, check " +
      "#32's bot gate and rate limit before suspecting #129",
  ).toContain('data-testid="lead-receipt"')

  const match = body.match(LEAD_REFERENCE)
  expect(match, "POST /start should mint a LEAD-XXXXXX reference").not.toBeNull()
  return { summary, email, reference: match![0] }
}

/**
 * File a request through `POST /intake` — used only as an instrument, exactly
 * as `128-clients-schema.spec.ts` uses it, to build a real `projects` row that
 * has never been through lead promotion.
 */
async function fileRequest(
  request: APIRequestContext,
  email: string,
  outcome: string,
  followUpFrom?: string,
): Promise<string> {
  const path = followUpFrom ? `/intake?from=${encodeURIComponent(followUpFrom)}` : "/intake"
  const res = await request.post(path, {
    headers: { [ACCESS_HEADER]: email },
    form: {
      outcome,
      audience: "The two people who keep the rota up to date",
      doneDefinition: "It is live and nobody has to explain it twice",
    },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  const status = res.status()
  expect(status, `POST ${path} should redirect to the new submission, got ${status}`).toBeGreaterThanOrEqual(300)
  expect(status, `POST ${path} should redirect to the new submission, got ${status}`).toBeLessThan(400)

  const location = res.headers()["location"] ?? ""
  const id = /\/submissions\/([A-Za-z0-9_-]+)/.exec(location)?.[1]
  expect(id, `POST ${path} should redirect to /submissions/:id, got ${location || "(no Location)"}`).toBeTruthy()
  return id as string
}

/**
 * A project built the only way a customer can (#109: a follow-up filed from an
 * existing submission), so it carries the customer's email and — per #128's
 * no-backfill clause — `client_id IS NULL`.
 */
async function projectViaFollowUp(request: APIRequestContext, email: string): Promise<string> {
  const origin = await fileRequest(request, email, "A rota page that loads before anyone gives up")
  await fileRequest(request, email, "The same rota page, now with reminders", origin)

  const dashboard = await request.get("/submissions", { headers: { [ACCESS_HEADER]: email } })
  expect(dashboard.status(), "the customer dashboard should render for the caller who just filed").toBe(200)
  const projectId = /href="\/projects\/([A-Za-z0-9_-]+)"/.exec(await dashboard.text())?.[1]
  expect(
    projectId,
    "a follow-up should have produced a project reachable from the dashboard (#109) — this " +
      "slice needs one to assert the contract's \"which projects are even offered\" rule against",
  ).toBeTruthy()
  return projectId as string
}

// ── the operator's screens ──────────────────────────────────────────────────

/** The `/leads/:id` path for a seeded lead, taken from its inbox row. */
async function leadPath(operator: Page, lead: SeededLead): Promise<string> {
  await operator.goto("/leads")
  const row = operator.getByTestId("lead-row").filter({ hasText: lead.reference })
  await expect(row, `exactly one inbox row for ${lead.reference}`).toHaveCount(1)
  const href = await row.getByTestId("review-lead").getAttribute("href")
  expect(href, "`review-lead` links to the lead's own detail screen").toMatch(/^\/leads\/[^/]+$/)
  return href!
}

/** Promote through the pinned form, the way an operator does. */
async function promote(operator: Page, path: string): Promise<string> {
  await expect(
    operator.getByTestId("lead-detail"),
    "promotion starts from an unpromoted lead",
  ).toHaveAttribute("data-status", "new")
  await operator.getByTestId("promote-button").click()
  await expect(
    operator.getByTestId("lead-detail"),
    "the promote POST redirects back to GET /leads/:id (ms-2's route table)",
  ).toHaveAttribute("data-status", "promoted")
  expect(new URL(operator.url()).pathname, "promotion lands back on the lead").toBe(path)

  const text = await operator.getByTestId("promoted-submission-reference").innerText()
  const match = text.match(SUBMISSION_REFERENCE)
  expect(match, `a promoted lead records the submission it produced, got: ${text}`).not.toBeNull()
  return match![0]
}

/** Open a seeded lead's detail screen as the operator, and return its path. */
async function openLead(operator: Page, lead: SeededLead): Promise<string> {
  const path = await leadPath(operator, lead)
  await operator.goto(path)
  return path
}

/** Seed a lead, open it, promote it. The whole no-choice happy path in one line. */
async function seedAndPromote(
  request: APIRequestContext,
  operator: Page,
  email: string,
  tag: string,
  nth: number,
): Promise<{ lead: SeededLead; path: string; reference: string }> {
  const lead = await seedLead(request, email, leadSummary(tag, nth))
  const path = await openLead(operator, lead)
  const reference = await promote(operator, path)
  return { lead, path, reference }
}

/** The `data-project-id` of every project offered on a match card, in render order. */
async function offeredProjectIds(page: Page): Promise<string[]> {
  return page
    .getByTestId("client-project-option")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-project-id") ?? ""))
}

/** The `name="projectChoice"` radio inside one option. */
function radioIn(option: Locator): Locator {
  return option.locator('input[type="radio"][name="projectChoice"]')
}

/**
 * Pick one option on the match card.
 *
 * The visibility assertion first is not decoration: `check()` on a locator that
 * will never exist waits out the whole *test* timeout, so a missing hook would
 * report as a two-and-a-half-minute hang with a stack trace instead of "this
 * option is not on the page". Pre-implementation, that is every run.
 */
async function choose(option: Locator, why: string): Promise<void> {
  await expect(option, why).toBeVisible()
  await radioIn(option).check({ timeout: 10_000 })
}

// ── tests ───────────────────────────────────────────────────────────────────

test.describe("ms-4 issue 129 lead promotion links a client", () => {
  /**
   * CONTROL — green before #129 lands, and it must STAY green.
   *
   * Contract § "Not re-rendered, described in prose instead": a lead whose
   * email matches no `clients` row renders a screen "byte-identical to
   * `tests/acceptance/ms-2/mocks/05-lead-detail.html`" — `client-match-card`
   * "simply does not render when `getClientByEmail` finds nothing", and "no new
   * copy is pinned for 'we didn't find anyone'".
   *
   * This guards the over-eager reading of #129: a card that renders for
   * everybody, or one that matches on something looser than the email (the
   * name, a domain), tells the operator "this looks like an existing client"
   * about a total stranger — which is the same class of mistake, pointed the
   * other way, as the one the epic was filed over. Per the observed-not-
   * intended rule it is absent from the manifest's `expected_red` block,
   * because it never failed.
   */
  test("a lead from an address no client has ever used shows no match card", async ({
    browser,
    baseURL,
    request,
  }) => {
    const lead = await seedLead(request, "stranger.129@example.test", leadSummary("stranger", 1))
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    await openLead(page, lead)

    await expect(page.getByTestId("lead-detail")).toHaveAttribute("data-status", "new")
    await expect(
      page.getByTestId("client-match-card"),
      "nothing may claim this stranger is an existing client",
    ).toHaveCount(0)
    await expect(page.getByTestId("client-match-email")).toHaveCount(0)
    await expect(page.getByTestId("client-match-project-count")).toHaveCount(0)
    await expect(page.getByTestId("client-project-list")).toHaveCount(0)
    await expect(page.getByTestId("client-project-option")).toHaveCount(0)
    await expect(page.getByTestId("client-project-option-new")).toHaveCount(0)

    // ...and the ms-2 screen underneath it is untouched.
    await expect(page.getByTestId("access-seat-reminder")).toBeVisible()
    await expect(page.getByTestId("promote-button")).toHaveText("Promote to submission")

    await context.close()
  })

  test("promoting an unrecognised email says a new client was created", async ({
    browser,
    baseURL,
    request,
  }) => {
    const email = "raf.newclient.129@example.test"
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const { reference } = await seedAndPromote(request, page, email, "newclient", 1)

    // Contract § "After promotion", mock 03. #129: the rendered response "says
    // the work is attached to the existing client, not just 'submission
    // created'" — the no-match branch is the same sentence, other value.
    const attachment = page.getByTestId("client-attachment")
    await expect(attachment, "promotion must say what it attached the work to").toBeVisible()
    await expect(attachment).toHaveAttribute("data-match", "new")
    await expect(
      attachment,
      "the contract pins that this text names the client's email",
    ).toContainText(email)
    // Contract: text "is not pinned verbatim beyond ... for no-match, that a new
    // client was created". Deliberately loose — mock 03's own wording ("created
    // a new client and started Project 1") and any equivalent both satisfy it.
    await expect(
      attachment,
      "the no-match branch has to say a client was newly created, not merely name an address",
    ).toContainText(/\bnew\b|\bcreat/i)

    // ms-2's hooks are unchanged by this milestone (contract preamble).
    await expect(page.getByTestId("access-seat-manual-step")).toBeVisible()
    await expect(page.getByTestId("promoted-submission-reference")).toContainText(reference)
    await expect(page.getByTestId("promote-lead-form")).toHaveCount(0)

    await context.close()
  })

  test("an unrecognised email gets a clients row with the email and nothing else", async ({
    browser,
    baseURL,
    request,
  }) => {
    // #129, no-match branch, verbatim: "auto-create a `clients` row (email only,
    // no phone/cc/address) and a project titled 'Project 1' ... in the same
    // batch, then attach the new submission to it."
    const email = "solo.newclient.129@example.test"
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const { reference } = await seedAndPromote(request, page, email, "solo", 1)

    const rows = clientRows(email)
    expect(rows.length, "promoting an unmatched lead creates exactly one client").toBe(1)
    expect(String(rows[0].email).toLowerCase(), "the client is keyed on the lead's own email").toBe(
      email.toLowerCase(),
    )
    for (const blank of ["phone", "cc_emails", "address"] as const) {
      // NULL or empty — a worker binding `undefined` gets NULL, one binding
      // `""` gets a blank string, and #129 says only that promotion creates the
      // row "email only, no phone/cc/address". Both record nothing; neither
      // invents a fact the lead never gave (filling these in is #131's job, and
      // it belongs to the client's own hands, not the operator's).
      const value = rows[0][blank]
      expect(
        value === null || value === "",
        `#129 creates the client from an email only — nothing may invent a ${blank} the lead ` +
          `never gave, but this row has ${JSON.stringify(value)}`,
      ).toBe(true)
    }

    // "...and a project ... in the same batch, then attach the new submission to it."
    const projects = projectIdsFor(String(rows[0].id))
    expect(
      projects.length,
      "the new client gets exactly one project — mock 03's 'Project 1'",
    ).toBe(1)
    expect(
      projectOfSubmission(reference),
      "the promoted submission is attached to the project promotion just created, not left loose",
    ).toBe(projects[0])

    await context.close()
  })

  test("the promoted screen shows where the attached submission is", async ({
    browser,
    baseURL,
    request,
  }) => {
    // Contract § "After promotion": `attached-submission-status` is "a
    // `.status-pill`-shaped element, `data-status` = the attached submission's
    // current customer-facing status (`describing` at first)". "This is new:
    // ms-2's contract never rendered the submission's own status on this
    // screen, only its reference."
    //
    // TODO(test-author): the contract introduces this hook inside its #129
    // section but lists it under "after promotion (mocks 02–05)", which #130
    // and #132 also render. Only the `describing` value — the one promotion
    // itself produces — is asserted here; the move to `planned` is #132's.
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    await seedAndPromote(request, page, "pill.129@example.test", "pill", 1)

    const pill = page.getByTestId("attached-submission-status")
    await expect(pill, "the operator can see where the submission they made actually is").toBeVisible()
    await expect(pill).toHaveAttribute("data-status", "describing")
    // ms-1 pins the customer-facing label for this status as "Describing".
    await expect(pill).toContainText(/describing/i)

    await context.close()
  })

  test("a returning address is recognised before the operator commits", async ({
    browser,
    baseURL,
    request,
  }) => {
    // The behaviour gap the epic was filed over: "a real customer's follow-up
    // lead was promoted with zero indication it belonged to someone the
    // operator had already worked with."
    const email = "dana.returning.129@example.test"
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()

    await seedAndPromote(request, page, email, "returning", 1)
    const second = await seedLead(request, email, leadSummary("returning", 2), "Dana")
    await openLead(page, second)

    // Contract § "Before promotion — client match", mock 01.
    const card = page.getByTestId("client-match-card")
    await expect(card, "the second lead from a known address is flagged as an existing client").toBeVisible()
    await expect(card).toHaveAttribute("data-match", "existing")
    await expect(page.getByTestId("client-match-email"), "the matched client's email, verbatim").toHaveText(
      email,
    )
    expect(
      (await page.getByTestId("client-match-project-count").innerText()).trim(),
      "the count is how many projects that client already has — one, from the first promotion",
    ).toMatch(/^1\b/)

    // The pinned chooser: a fieldset of `name="projectChoice"` radios, one
    // `client-project-option` (`data-project-id`) per existing project plus one
    // `client-project-option-new` (`value="new"`).
    const list = page.getByTestId("client-project-list")
    await expect(list).toBeVisible()
    expect(
      (await list.evaluate((node) => node.tagName)).toLowerCase(),
      "the contract pins `client-project-list` as a <fieldset>",
    ).toBe("fieldset")

    const options = page.getByTestId("client-project-option")
    await expect(options, "one option per project the client already has").toHaveCount(1)
    const ids = await offeredProjectIds(page)
    expect(ids[0], "each option carries the project it stands for in `data-project-id`").toMatch(/\S/)
    await expect(radioIn(options.first()), "the choice is a projectChoice radio").toHaveCount(1)

    const newOption = page.getByTestId("client-project-option-new")
    await expect(newOption, "the operator can always start a fresh project instead").toBeVisible()
    await expect(
      newOption.locator('input[name="projectChoice"][value="new"]'),
      'the contract pins the new-project option\'s value as "new"',
    ).toHaveCount(1)

    // "The newest/most-recent project is pre-selected" — with exactly one
    // project that is the only real option, and never "start a new one".
    await expect(radioIn(options.first())).toBeChecked()
    await expect(
      newOption.locator('input[name="projectChoice"]'),
      "starting a new project is not the default for a client who already has one",
    ).not.toBeChecked()

    // ms-2's screen underneath is unchanged: same single form, same button
    // text, same seat reminder, "one POST, no separate confirmation step".
    const form = page.getByTestId("promote-lead-form")
    await expect(form).toHaveAttribute("method", /post/i)
    await expect(form).toHaveAttribute("action", /^\/leads\/[^/]+\/promote$/)
    await expect(page.getByTestId("promote-button")).toHaveText("Promote to submission")
    await expect(page.getByTestId("access-seat-reminder")).toBeVisible()

    await context.close()
  })

  test("promoting into a matched client says the work joined that client", async ({
    browser,
    baseURL,
    request,
  }) => {
    const email = "joins.129@example.test"
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()

    const first = await seedAndPromote(request, page, email, "joins", 1)
    const second = await seedLead(request, email, leadSummary("joins", 2))
    const secondPath = await openLead(page, second)
    const offered = await offeredProjectIds(page)
    expect(offered.length, "the client from the first promotion has one project to offer").toBe(1)
    const reference = await promote(page, secondPath)

    // Contract § "After promotion", mock 02 — `data-match="existing"`, naming
    // the client's email.
    const attachment = page.getByTestId("client-attachment")
    await expect(attachment, "promotion must say the work joined someone already known").toBeVisible()
    await expect(attachment).toHaveAttribute("data-match", "existing")
    await expect(attachment).toContainText(email)

    // TODO(test-author): the contract also requires this text to name "the
    // project it joined", but pins no name to compare against — § "The 'Project
    // 1' title" is explicit that a project has no stored title and that what a
    // project displays is derived from the newest submission under it, which at
    // this instant is the one just attached. Rather than guess a string, the
    // attachment itself is asserted as a fact below.
    expect(
      projectOfSubmission(reference),
      "the second request lands in the client's existing project, not a second one",
    ).toBe(offered[0])

    const rows = clientRows(email)
    expect(rows.length, "a second promotion for a known address creates no second client").toBe(1)
    expect(
      projectIdsFor(String(rows[0].id)).length,
      "attaching to an existing project must not silently create another one",
    ).toBe(1)

    await context.close()
  })

  test("the operator can start a new project for a client who already has one", async ({
    browser,
    baseURL,
    request,
  }) => {
    const email = "another.129@example.test"
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()

    await seedAndPromote(request, page, email, "another", 1)

    const second = await seedLead(request, email, leadSummary("another", 2))
    const secondPath = await openLead(page, second)
    const [firstProject] = await offeredProjectIds(page)
    expect(firstProject, "the first promotion left one project to choose between").toMatch(/\S/)

    // Contract: `client-project-option-new` (`value="new"`) — "or creates a new
    // project for that client instead", submitted in the same promote POST.
    await choose(
      page.getByTestId("client-project-option-new"),
      "the operator must be able to decline every existing project and start a fresh one",
    )
    const reference = await promote(page, secondPath)

    await expect(page.getByTestId("client-attachment")).toHaveAttribute("data-match", "existing")

    const rows = clientRows(email)
    expect(rows.length, "still one client — a new project is not a new client").toBe(1)
    const projects = projectIdsFor(String(rows[0].id))
    expect(projects.length, "choosing 'start a new project' gives this client a second one").toBe(2)
    expect(projects, "the first project is still there").toContain(firstProject)
    const landed = projectOfSubmission(reference)
    expect(projects, "the new submission is in one of this client's projects").toContain(landed)
    expect(landed, "it is in the NEW project, not the one the operator declined").not.toBe(
      firstProject,
    )

    // A third lead now sees both, with the newest pre-selected.
    const third = await seedLead(request, email, leadSummary("another", 3))
    await openLead(page, third)
    expect(
      (await page.getByTestId("client-match-project-count").innerText()).trim(),
      "the count follows the projects the client actually has",
    ).toMatch(/^2\b/)
    const options = page.getByTestId("client-project-option")
    await expect(options, "both of this client's projects are offered").toHaveCount(2)
    expect((await offeredProjectIds(page)).slice().sort(), "and they are the two that exist").toEqual(
      projects.slice().sort(),
    )

    const newestOption = page.locator(
      `[data-testid="client-project-option"][data-project-id="${landed}"]`,
    )
    await expect(newestOption, "the project just created is on offer next time").toHaveCount(1)
    await expect(
      radioIn(newestOption),
      "contract: 'the newest/most-recent project is pre-selected'",
    ).toBeChecked()
    await expect(
      radioIn(
        page.locator(`[data-testid="client-project-option"][data-project-id="${firstProject}"]`),
      ),
      "the older project is offered, but not chosen for the operator",
    ).not.toBeChecked()

    await context.close()
  })

  test("the operator's chosen project is the one the submission lands in", async ({
    browser,
    baseURL,
    request,
  }) => {
    const email = "picks.129@example.test"
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()

    // Build a client with two projects: promote once (auto), then once more
    // choosing "start a new project".
    await seedAndPromote(request, page, email, "picks", 1)
    const second = await seedLead(request, email, leadSummary("picks", 2))
    const secondPath = await openLead(page, second)
    const [oldest] = await offeredProjectIds(page)
    expect(oldest, "the first promotion left one project to build on").toMatch(/\S/)
    await choose(
      page.getByTestId("client-project-option-new"),
      "building a second project for this client needs the new-project option",
    )
    await promote(page, secondPath)

    // Now the operator deliberately picks the OLDER project — the one that is
    // not pre-selected — so a worker that ignores `projectChoice` and always
    // uses the default cannot pass.
    const third = await seedLead(request, email, leadSummary("picks", 3))
    const thirdPath = await openLead(page, third)
    await expect(page.getByTestId("client-project-option")).toHaveCount(2)
    const chosen = page.locator(
      `[data-testid="client-project-option"][data-project-id="${oldest}"]`,
    )
    await choose(chosen, "the project promoted first is still on offer")
    const reference = await promote(page, thirdPath)

    expect(
      projectOfSubmission(reference),
      "the submission joins the project the operator picked, not the pre-selected one",
    ).toBe(oldest)
    await expect(page.getByTestId("client-attachment")).toHaveAttribute("data-match", "existing")

    const rows = clientRows(email)
    expect(rows.length, "three promotions for one address, still one client").toBe(1)
    expect(
      projectIdsFor(String(rows[0].id)).length,
      "picking an existing project creates no third one",
    ).toBe(2)

    await context.close()
  })

  test("a double-submitted promotion creates one submission and one client", async ({
    browser,
    baseURL,
    request,
  }) => {
    // #129: "Stays inside 0007's existing idempotency guard: the whole thing is
    // one transaction keyed on `leads.promoted_at IS NULL`, so a double-click or
    // retry still converges on one submission (and does not double-create a
    // client)."
    const email = "twice.129@example.test"
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const { path, reference } = await seedAndPromote(request, page, email, "twice", 1)

    const retries = await Promise.all([
      context.request.post(`${path}/promote`, { form: {}, maxRedirects: 0, failOnStatusCode: false }),
      context.request.post(`${path}/promote`, { form: {}, maxRedirects: 0, failOnStatusCode: false }),
      context.request.post(`${path}/promote`, { form: {}, maxRedirects: 0, failOnStatusCode: false }),
    ])
    for (const response of retries) {
      expect(
        response.status(),
        "a retried promote is not an error — it converges on what already happened",
      ).toBeLessThan(400)
    }

    await page.goto(path)
    await expect(page.getByTestId("promoted-submission-reference")).toContainText(reference)

    const rows = clientRows(email)
    expect(
      rows.length,
      "four promotes of one lead must leave exactly one client — the email is UNIQUE, so a " +
        "second insert either throws or silently swallows a failure the operator never sees",
    ).toBe(1)
    expect(
      projectIdsFor(String(rows[0].id)).length,
      "and exactly one project, not one per attempt",
    ).toBe(1)

    const submissions = d1(
      `SELECT id FROM submissions WHERE lower(customer_email) = lower(${quote(email)})`,
    )
    expect(submissions.ok, `reading \`submissions\` should succeed. SQLite said: ${submissions.error}`).toBe(
      true,
    )
    expect(submissions.rows.length, "and exactly one submission").toBe(1)

    await context.close()
  })

  test("a client match ignores the case of the email address", async ({
    browser,
    baseURL,
    request,
  }) => {
    // TODO(test-author): contract Note 3 flags this as the contract's own
    // inference — "#128 or #129 [do not specify] ... this contract assumes
    // case-insensitive matching, by analogy with `src/operators.ts`'s own
    // allowlist comparison". Asserted because the contract states it outright;
    // a worker who reads the issues and matches case-sensitively is diverging
    // from the contract, not from #129's literal text.
    const mixed = "Mika.Case.129@Example.test"
    const lower = mixed.toLowerCase()
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()

    await seedAndPromote(request, page, mixed, "case", 1)

    const second = await seedLead(request, lower, leadSummary("case", 2))
    const secondPath = await openLead(page, second)
    await expect(
      page.getByTestId("client-match-card"),
      "the same person typing their address in lower case is the same client",
    ).toBeVisible()
    await expect(page.getByTestId("client-match-card")).toHaveAttribute("data-match", "existing")
    await expect(page.getByTestId("client-project-option")).toHaveCount(1)

    const reference = await promote(page, secondPath)
    await expect(page.getByTestId("client-attachment")).toHaveAttribute("data-match", "existing")

    const rows = clientRows(lower)
    expect(rows.length, "a casing difference must not mint a second client").toBe(1)
    const projects = projectIdsFor(String(rows[0].id))
    expect(projects.length, "nor a second project").toBe(1)
    expect(projectOfSubmission(reference), "the follow-up joins the project already there").toBe(
      projects[0],
    )

    await context.close()
  })

  test("a project that never came from a lead promotion is not offered", async ({
    browser,
    baseURL,
    request,
  }) => {
    // Contract § "Which projects are even offered": the list is built from
    // projects that "already carry the matched `clients.id` in `client_id`". A
    // project created "via a customer's own 'Start a follow-up' action" shares
    // the email but has `client_id IS NULL` (#128: no backfill, no inference
    // from a matching email) "and will **not** appear in either list. A test may
    // create such a project and assert it is absent from both."
    //
    // The contract's own Note 5 is candid that this makes the list "not the same
    // thing as everything this client actually has with us" — that is the pinned
    // rule regardless, and this test holds the implementation to it rather than
    // to the friendlier reading.
    const email = "orphan.129@example.test"
    const orphan = await projectViaFollowUp(request, email)

    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    await seedAndPromote(request, page, email, "orphan", 1)

    const second = await seedLead(request, email, leadSummary("orphan", 2))
    await openLead(page, second)

    await expect(page.getByTestId("client-match-card")).toHaveAttribute("data-match", "existing")
    const offered = await offeredProjectIds(page)
    expect(
      offered,
      "the customer's own follow-up project was never linked to a client, so it is not on offer",
    ).not.toContain(orphan)
    expect(offered.length, "only the project lead promotion created is offered").toBe(1)
    expect(
      (await page.getByTestId("client-match-project-count").innerText()).trim(),
      "and the count matches the list, rather than counting rows the list will not show",
    ).toMatch(/^1\b/)

    await context.close()
  })
})
