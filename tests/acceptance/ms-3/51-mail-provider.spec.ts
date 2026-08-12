import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test"

/**
 * ms-3 sealed acceptance slice — issue #51
 * "[portal] MailProvider adapter — Resend behind an interface, with a recording
 *  fake for tests"
 *
 * Written from `tests/acceptance/ms-3/contract.md` (§ "The provider seam",
 * § "Route surface", § "Delivery state vocabulary", § "`data-testid` hooks",
 * § "Customer-safe error copy", Notes items 5 and 7) and from the `/outbox`
 * mocks that contract pins — `mocks/01-outbox-queued.html`,
 * `mocks/02-outbox-sent.html`, `mocks/03-outbox-failed.html`,
 * `mocks/04-outbox-mixed.html`, every one of which renders `email-from` as
 * `coord-portal <notify@intake.heurontech.com>` — without sight of any
 * implementation.
 *
 * WHAT IS LEFT FOR THIS SLICE. `manifest.yml` says it directly, and it is right:
 * #50's block "already exercises the fake's pinned black-box behaviour end to
 * end (a `mailfail` recipient always fails, everyone else succeeds) because that
 * is the only lever #50's own transitions can be driven with. #51's slice should
 * assert what is left — fail-closed on an unset key, `MAIL_PROVIDER` selection —
 * not re-assert these." So this slice deliberately does NOT re-test the drain's
 * transitions, its retry arc, its give-up count, or its claiming safety. It
 * tests the four things #51 owns that survive that subtraction:
 *
 *   CONFIG      `EMAIL_FROM` is a var in `Env`, not a literal compiled into the
 *               app ("`EMAIL_FROM` moves out of the hardcoded literal in
 *               `src/notifications.ts` and into `Env`"), and `RESEND_API_KEY` is
 *               a secret that exists NOWHERE in this repository ("Never in git —
 *               this repo is public").
 *   FROM        what the configured address actually produces on the screen: the
 *               address a customer reads is the configured one, in every
 *               delivery state, not something the provider path rewrites.
 *   FAIL CLOSED "never silently succeed, and never crash the scheduled handler."
 *               An address the provider can never accept must never be reported
 *               as delivered at ANY point in its arc, and must not take the rest
 *               of the queue — another customer's mail — down with it.
 *   NO LEAK     the credential and the provider's own error material must never
 *               reach a customer's rendered page. #49/#50 assert the vocabulary
 *               wall on `delivery-last-error`; this slice adds the one shape
 *               those word-lists cannot catch, an actual API key.
 *
 * WHY TWO TESTS READ FILES. Contract § preamble is explicit that this
 * milestone's black-box surface is not only pixels: "This is the black-box
 * surface: exact route paths, screen text, `data-testid` hooks, status
 * vocabulary, and (because this milestone's real surface is mostly a state
 * machine, not new screens) **config-var names** and a deterministic test-fake
 * hook". `EMAIL_FROM`-is-configuration and the-key-is-not-in-git are contract
 * clauses with no rendered representation at all — an oracle that only drives
 * the browser cannot gate either, and "the key was committed to a public repo"
 * is the one failure in this milestone that cannot be undone by a follow-up
 * commit. So those two are read off the repository itself, and everything else
 * here is driven through the deployed HTTP surface like every other slice.
 *
 * NOT COVERED HERE, and why — all four are contract gaps, not oversights:
 *
 *  - **The recording fake's recordings.** #51's own Scope asks for "a fake…
 *    that records the payloads it was handed, so a sealed test can assert *what
 *    would have been sent* without sending it" — and the contract pins NO route,
 *    no dev-only endpoint and no DOM hook that exposes them. Contract § "The
 *    provider seam" says the opposite in as many words: "The sealed suite never
 *    imports or calls `MailProvider` directly… Everything it can assert about
 *    #51 is mediated through `outbox` row transitions." #50's slice flagged the
 *    same gap from the other side ("a counter on #51's fake, exposed on a
 *    dev-only route, is what would close the gap, and no issue asks for one").
 *    TODO(test-author): this is the single largest unassertable clause in #51.
 *    Closing it needs a contract amendment naming a dev-only read surface for
 *    the fake's log; inventing one here would be inventing product.
 *  - **Fail-closed against a real unset/invalid `RESEND_API_KEY`.** The
 *    contract's own fail-closed clause is about "the real-provider path", and
 *    § "The provider seam" pins that `env.MAIL_PROVIDER === "fake"` "forces the
 *    recording fake regardless of whether `RESEND_API_KEY` is set", which is
 *    what `serve:acceptance` boots. A sealed test cannot restart the Worker
 *    under a different environment, so the *real* Resend path is unreachable
 *    from here by construction. TODO(test-author): what this slice can and does
 *    assert is the behaviour the contract says an unset key must produce —
 *    never a false `sent`, never a dead scheduled handler — driven through the
 *    one deterministic failure lever the contract does pin (`mailfail`). If the
 *    real path diverges from the fake's path, no test in this milestone can
 *    tell; that is the contract's Notes item 5 trade-off, flagged not fixed.
 *  - **That the fake was selected BY `MAIL_PROVIDER` rather than by the key's
 *    absence.** Contract § "The provider seam" is emphatic that these must be
 *    different mechanisms ("absence is supposed to mean 'fail closed,' not 'use
 *    the fake'… conflating them would make the fail-closed path untestable"),
 *    and equally emphatic that the acceptance environment has both conditions
 *    true at once. One environment cannot distinguish two causes. TODO(test-
 *    author): distinguishing them needs a second acceptance environment
 *    (`MAIL_PROVIDER` unset, no key) that nothing in this repo's harness
 *    provides.
 *  - **`provider_message_id`.** #51's interface returns "a provider message id
 *    or an error", but contract § "`data-testid` hooks" says
 *    `delivery-provider-id` is "**not part of this contract**… no test in this
 *    milestone should require it" on the customer page. Contract Notes item 8
 *    argues `/deliveries` (#55) is where it should surface; that is #55's slice
 *    to write, not this one's.
 *  - **Whether mail is delivered**, per #53's own framing: "nothing in this repo
 *    can observe a real inbox."
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and contract § "Synthetic data", every
 * address, submission and design round below is invented on the reserved
 * `example.test` TLD.
 */

// ── the pinned routes and vocabulary ────────────────────────────────────────

/** Contract § "Route surface (pinned)". */
const OUTBOX = "/outbox"

/** Contract § "Triggering the drain in the sealed suite". */
const DRAIN = "/__scheduled"

/** `playwright.acceptance.config.ts`'s own readiness probe — reused here as a liveness probe. */
const HEALTH = "/api/health"

const DRAIN_UNAVAILABLE =
  `ms-3 issue #51 cannot be observed at all: \`GET ${DRAIN}\` did not answer 2xx. ` +
  "The provider seam has no HTTP surface of its own (contract § \"The provider seam\": it is a " +
  "code-level seam, \"not HTTP surface\"), so everything this slice asserts is mediated through " +
  "`outbox` transitions that only the drain can produce. Contract § \"Triggering the drain in " +
  "the sealed suite\" pins that path, and requires `--test-scheduled` on both `serve:acceptance` " +
  "and `serve:test`. If this is failing, fix #50's trigger first — nothing in #51 is gateable " +
  "until it answers."

/** Contract § "Delivery state vocabulary (pinned, from issue #49)". */
const STATUS_TEXT = {
  queued: "Queued",
  sent: "Sent",
  failed: "Delivery failed",
} as const

type DeliveryStatus = keyof typeof STATUS_TEXT

const TERMINAL: DeliveryStatus[] = ["sent", "failed"]

/**
 * Contract § "The provider seam": "`env.EMAIL_FROM` — var (not secret),
 * replaces the hardcoded literal currently in `src/notifications.ts`
 * (`"coord-portal <notify@intake.heurontech.com>"`). This contract pins that the
 * acceptance environment's value stays exactly that literal, matching every
 * existing ms-1 mock and the new ms-3 mocks".
 *
 * Every one of `mocks/01`–`04` renders exactly this in `email-from`.
 */
const PINNED_EMAIL_FROM = "coord-portal <notify@intake.heurontech.com>"

/** Contract § "The provider seam": the two config-var names it pins by name. */
const FROM_VAR = "EMAIL_FROM"
const KEY_VAR = "RESEND_API_KEY"

/**
 * Contract § "The provider seam", the deterministic failure hook: "the fake
 * succeeds for every recipient **except** one whose local-part contains the
 * substring `mailfail` (case-insensitive)… for which it deterministically fails
 * every call. This is the only black-box lever the sealed suite has to drive a
 * row all the way to `failed`."
 *
 * Used here only as an instrument for #51's fail-closed clause — the hook's own
 * behaviour is #50's slice's subject, per `manifest.yml`'s note.
 */
const FAKE_FAILS = "mailfail"

// ── the repository, as a config surface ─────────────────────────────────────

/**
 * The checkout this suite is running against. `process.cwd()` is the Playwright
 * config's directory (the repo root) for both `npm run test:acceptance` and the
 * coordinator's external re-run, but walking up to the marker file makes that an
 * assertion rather than an assumption.
 */
function repoRoot(): string {
  let dir = process.cwd()
  for (let hops = 0; hops < 8; hops++) {
    if (existsSync(join(dir, "wrangler.toml")) && existsSync(join(dir, "package.json"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    `could not locate the repo root (no wrangler.toml + package.json) walking up from ` +
      `${process.cwd()} — this slice reads the committed Worker configuration, which contract ` +
      "§ preamble names as part of ms-3's black-box surface (\"config-var names\")",
  )
}

/** Every file git actually tracks — "never in git" is a statement about exactly this set. */
function trackedFiles(root: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    const files = out.split("\0").filter(Boolean)
    if (files.length > 0) return files
  } catch {
    // fall through to the walk below
  }

  // Fallback for a checkout with no usable git (an exported tarball, say). Less
  // precise — it can see untracked files — but it never silently scans nothing,
  // which would turn this test into a confidently-wrong green.
  const skip = new Set([".git", "node_modules", ".wrangler", "dist", "test-results", "playwright-report"])
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else found.push(relative(root, full))
    }
  }
  walk(root)
  return found
}

const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|gz|sqlite|db|wasm)$/i

function readText(root: string, file: string): string | null {
  if (BINARY.test(file)) return null
  const full = resolve(root, file)
  try {
    if (statSync(full).size > 2_000_000) return null
    return readFileSync(full, "utf8")
  } catch {
    return null
  }
}

/**
 * Where the acceptance environment's `EMAIL_FROM` is declared, if anywhere.
 *
 * Contract § "The provider seam" pins it as a **var** ("not secret"), so it has
 * to be declared in configuration a reader can see — that is the whole content
 * of "moves out of the hardcoded literal… and into `Env`". This deliberately
 * accepts either of the two forms wrangler offers, because the contract names
 * neither:
 *
 *   1. `--var EMAIL_FROM:<value>` on the `serve:acceptance` script, the same
 *      mechanism that script already uses for `MAIL_PROVIDER`, and
 *   2. a `[vars]` table in `wrangler.toml`.
 *
 * (1) wins if both exist, since it is what the acceptance Worker actually boots
 * with. TODO(test-author): the contract does not pin WHICH file declares it, so
 * this accepts both rather than inventing a placement rule; an implementer who
 * declares it a third way (a `.dev.vars` for local dev only, say) would fail
 * this and should amend the contract rather than be worked around here — a var
 * that only exists in a gitignored file is not a var this repo's deploy has.
 */
function declaredEmailFrom(root: string): { value: string; where: string } | null {
  const pkgPath = join(root, "package.json")
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> }
    const serve = pkg.scripts?.["serve:acceptance"] ?? ""
    const flag = new RegExp(`--var\\s+${FROM_VAR}[:=]([^\\s"']+|"[^"]*"|'[^']*')`).exec(serve)
    if (flag) {
      return { value: flag[1].replace(/^["']|["']$/g, ""), where: "package.json scripts.serve:acceptance --var" }
    }
  }

  const tomlPath = join(root, "wrangler.toml")
  if (existsSync(tomlPath)) {
    const toml = readFileSync(tomlPath, "utf8")
    const assigned = new RegExp(`^\\s*${FROM_VAR}\\s*=\\s*["']([^"']*)["']`, "m").exec(toml)
    if (assigned) return { value: assigned[1], where: "wrangler.toml [vars]" }
  }

  return null
}

// ── bridge transport (the instrument, not the subject) ──────────────────────

/**
 * TODO(test-author): identical to the note in `ms-1/14-notifications.spec.ts`,
 * `ms-3/49-outbox-delivery-state.spec.ts` and `ms-3/50-drain.spec.ts` — ms-1's
 * contract pins the two header names but not how a Worker booted by
 * `npm run serve:acceptance` learns which pair is valid, and ms-3's contract
 * does not reopen the question. Same escape hatch, same defaults, so all four
 * slices agree.
 */
const SERVICE_TOKEN = {
  "CF-Access-Client-Id":
    process.env.COORD_BRIDGE_CLIENT_ID ?? "9f2c17b4a8de40518c6b3ad0e75f1c62.access",
  "CF-Access-Client-Secret":
    process.env.COORD_BRIDGE_CLIENT_SECRET ??
    "4d1e9c07b35a2f68e4c81079ba6d35f2c9017e4ab8d562309fc71ea48b0d63a5",
}

interface PushResult {
  submission_id: string
  outcome: string
  reason?: string
}

async function pushFields(
  request: APIRequestContext,
  submissionId: string,
  revision: number,
  fields: Record<string, unknown>,
): Promise<PushResult> {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: submissionId, revision, fields }] },
    headers: SERVICE_TOKEN,
  })
  expect(res.status(), "a push with a valid service token is 200").toBe(200)
  const body = (await res.json()) as { results: PushResult[] }
  expect(body.results, "one result per update").toHaveLength(1)
  return body.results[0]
}

// ── synthetic material ──────────────────────────────────────────────────────

const SEEDS = [
  {
    outcome: "A printable seed-swap sheet for the allotment shed noticeboard.",
    audience: "everyone who turns up on a Sunday",
    doneDefinition: "Someone can see what seed is going spare without asking around.",
  },
  {
    outcome: "A short note telling plot holders when the water is turned back on.",
    audience: "plot holders over winter",
    doneDefinition: "Nobody walks down with a watering can in February for nothing.",
  },
  {
    outcome: "A list of which hand tools are out on loan and to whom.",
    audience: "the shed steward",
    doneDefinition: "The steward can chase a missing spade without a memory test.",
  },
]

const ROUND = {
  round: 1,
  outcome: "Plot holders can read the seed-swap sheet from the shed noticeboard.",
  decomposition: [
    "A printable sheet listing seed offered and seed wanted",
    "A way for a plot holder to add a line to it before Sunday",
  ],
  mockBundleUrl: "https://mocks.example.test/seed-swap/round-1/",
}

const QUESTION =
  "Should the sheet show who offered each packet, or is an anonymous list less awkward for people?"

/**
 * One inbox per test — the acceptance database is wiped per *run*, not per
 * *test*, so isolation comes from each test owning a distinct recipient. Every
 * address here is invented; the two groups are split on the `mailfail`
 * substring on purpose and nothing in the DELIVERS group may ever contain it.
 */
const INBOX = {
  // must succeed at the fake
  from: "swap-provider-from@example.test",
  neighbourA: "swap-provider-neighbour-a@example.test",
  neighbourB: "swap-provider-neighbour-b@example.test",
  // must fail at the fake, every call, forever
  fromFailed: "swap-mailfail-from@example.test",
  stalls: "swap-mailfail-stalls@example.test",
  wedges: "swap-mailfail-wedges@example.test",
}

const REFERENCE = /^SUB-[A-Z0-9]{6}$/

// ── seeding and reading, through the pinned customer surface ────────────────

/** The verified-identity mechanism ms-1's screens assume is in front of them. */
function asCustomer(page: Page, email: string) {
  return page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
}

/** Author one submission through ms-1's pinned intake form (#9's surface). */
async function seedSubmission(page: Page, n: number): Promise<string> {
  const seed = SEEDS[n % SEEDS.length]
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(seed.outcome)
  await page.getByTestId("field-audience").fill(seed.audience)
  await page.getByTestId("field-done-definition").fill(seed.doneDefinition)
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const shown = (await page.getByTestId("submission-reference").innerText()).trim()
  const reference = shown.replace(/^Reference\s+/, "")
  expect(reference, "the receipt shows a SUB-XXXXXX reference").toMatch(REFERENCE)
  return reference
}

/** The three fields that make a submission ready for sign-off, in one push. */
function signoffFields() {
  return {
    status: "awaiting-signoff",
    design_round: {
      round: ROUND.round,
      outcome_definition: ROUND.outcome,
      mock_bundle_url: ROUND.mockBundleUrl,
    },
    decomposition: ROUND.decomposition,
  }
}

/** Collapse the incidental whitespace of rendered HTML before comparing copy. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Row {
  status: string | null
  pillText: string | null
  /** ms-1's `email-from` — the hook this slice is actually about. */
  from: string | null
  sentAt: string | null
  attempts: string | null
  lastError: string | null
}

async function readRow(preview: Locator): Promise<Row> {
  const textOf = async (testId: string): Promise<string | null> => {
    const node = preview.getByTestId(testId)
    return (await node.count()) === 0 ? null : flat(await node.first().innerText())
  }

  return {
    status: await preview.getAttribute("data-status"),
    pillText: await textOf("delivery-status"),
    from: await textOf("email-from"),
    sentAt: await textOf("delivery-sent-at"),
    attempts: await textOf("delivery-attempts"),
    lastError: await textOf("delivery-last-error"),
  }
}

/**
 * Every row on the caller's own `/outbox`, in DOM order. Filtered by `email-to`
 * so that a globally-scoped outbox and a caller-scoped one are both readable —
 * the same indifference ms-1's, #49's and #50's slices build in.
 */
async function readOutbox(page: Page, to: string): Promise<Row[]> {
  const response = await page.goto(OUTBOX)
  expect(response?.ok(), `contract § Route surface pins \`GET ${OUTBOX}\``).toBe(true)

  const previews = page.getByTestId("email-preview")
  const rows: Row[] = []
  for (let i = 0; i < (await previews.count()); i++) {
    const preview = previews.nth(i)
    const recipient = preview.getByTestId("email-to")
    if ((await recipient.count()) > 0 && !flat(await recipient.first().innerText()).includes(to)) {
      continue
    }
    rows.push(await readRow(preview))
  }
  return rows
}

/**
 * Wait until the caller's outbox holds exactly `expected` rows. The send is
 * DECIDED asynchronously by #14, before any provider is involved at all — a
 * failure here means the row was never queued, which is ms-1's subject, not
 * #51's.
 */
async function awaitOutbox(page: Page, to: string, expected: number): Promise<Row[]> {
  let rows: Row[] = []
  await expect
    .poll(
      async () => {
        rows = await readOutbox(page, to)
        return rows.length
      },
      { message: `${to} must have exactly ${expected} outbox row(s)`, timeout: 30_000 },
    )
    .toBe(expected)
  return rows
}

/** Fire the Cron Trigger once; a non-2xx means the seam cannot be observed at all. */
async function runDrain(request: APIRequestContext): Promise<void> {
  const res = await request.get(DRAIN)
  expect(res.ok(), `${DRAIN_UNAVAILABLE} (got HTTP ${res.status()})`).toBe(true)
}

/** Seed one submission for `to` and push one coord-owned change that decides a send. */
async function queueOneFor(
  page: Page,
  request: APIRequestContext,
  to: string,
  seedIndex: number,
  revision: number,
  fields: Record<string, unknown>,
): Promise<Row> {
  await asCustomer(page, to)
  const reference = await seedSubmission(page, seedIndex)
  expect(
    (await pushFields(request, reference, revision, fields)).outcome,
    "the pushed fields are entirely coord-owned",
  ).toBe("applied")

  const [row] = await awaitOutbox(page, to, 1)
  expect(row.status, "positive control: per #49 a decided send is born `queued`").toBe("queued")
  return row
}

// ── the slice ───────────────────────────────────────────────────────────────

test.describe("ms-3 issue 51 the mail provider seam", () => {
  test("the sending address is configuration and the Resend key is nowhere in the repository", async () => {
    // Issue #51 Scope, two clauses with no rendered representation, both of
    // which contract § preamble names as part of this milestone's black-box
    // surface ("config-var names"):
    //
    //   "`RESEND_API_KEY` supplied via `wrangler secret put`. **Never in git —
    //    this repo is public.**"
    //   "`EMAIL_FROM` moves out of the hardcoded literal in
    //    `src/notifications.ts` and into `Env`. (Raised as a non-blocking
    //    finding on #14: a per-environment sending address currently needs a
    //    code change rather than a config change.)"
    //
    // CLAUDE.md § Secrets says the same thing harder: "The repo is public —
    // assume anything committed is published permanently." That is why this is
    // asserted at all rather than left to review: a leaked key can be rotated,
    // but the commit cannot be recalled from forks or caches, so this is the one
    // failure in ms-3 that no later commit can undo.
    const root = repoRoot()

    // 1. The address is declared as a var somewhere a deploy can see.
    const declared = declaredEmailFrom(root)
    expect(
      declared,
      `#51: \`${FROM_VAR}\` must be a var in \`Env\`, declared in committed configuration — ` +
        "either `--var EMAIL_FROM:<value>` on `serve:acceptance` (the same mechanism that " +
        "script already uses for `MAIL_PROVIDER`) or a `[vars]` table in `wrangler.toml`. " +
        "Contract § \"The provider seam\" pins it as \"var (not secret)\"; the whole point of " +
        "the clause is that a per-environment sending address stops being a code change. " +
        "Found no declaration in either place.",
    ).not.toBeNull()

    expect(
      (declared as { value: string }).value,
      `contract § "The provider seam": "This contract pins that the acceptance environment's ` +
        `value stays exactly that literal, matching every existing ms-1 mock and the new ms-3 ` +
        `mocks" — declared at ${(declared as { where: string }).where}`,
    ).toBe(PINNED_EMAIL_FROM)

    // 2. The key is not in git, in any shape.
    const files = trackedFiles(root)
    expect(
      files.length,
      "the tracked-file scan must actually see files — an empty scan is a confidently-wrong green",
    ).toBeGreaterThan(10)

    // Neither of the two files a key is most often parked in may be tracked at
    // all, and `.dev.vars` (contract § "The provider seam": where `MAIL_PROVIDER`
    // is set for local dev) must be ignored rather than merely absent today.
    for (const file of files) {
      expect(
        file,
        `\`${file}\` is tracked in git. CLAUDE.md § Secrets: a provider key lives in ` +
          "`wrangler secret put`, never in a committed `.dev.vars`, never in a fixture.",
      ).not.toMatch(/(^|\/)(\.dev\.vars|\.env)(\.|$)/)
    }
    const gitignore = readText(root, ".gitignore") ?? ""
    expect(
      gitignore,
      "`.dev.vars` must be gitignored, not just missing — contract § \"The provider seam\" " +
        "expects `MAIL_PROVIDER` to be set there for local dev, which puts a file next to the " +
        "key's most likely home in every developer's checkout",
    ).toMatch(/^\s*\.dev\.vars\s*$/m)

    // A Resend credential, by shape.
    //
    // TODO(test-author): neither #51 nor the contract pins the key's format, so
    // this is a shape heuristic (Resend issues `re_`-prefixed tokens) rather
    // than a contract-derived pattern. It can produce a false negative for a
    // differently-shaped credential; the assignment check below is the
    // format-independent half.
    const KEY_SHAPED = /\bre_[A-Za-z0-9_-]{16,}/
    const PLACEHOLDER = /^(<|\$|\{|your|placeholder|example|changeme|todo|xxx|\.\.\.)/i

    // The format-independent half: `RESEND_API_KEY` assigned a value that is
    // long enough and mixed enough to be a real credential rather than a test
    // double.
    //
    // TODO(test-author): "long and contains a digit" is a heuristic, and it is
    // deliberately loose in one direction — a unit test may legitimately hand a
    // fake provider a short obviously-fake string, and an oracle that failed on
    // that would be crying wolf about the one alarm that must never be ignored.
    // The `re_` shape check above is the tight half for this repo's actual
    // provider. Neither #51 nor the contract pins a key format, so a
    // credential-shape test cannot be derived more precisely than this.
    const CREDENTIAL_SHAPED = /^(?=.*\d)[A-Za-z0-9_.\-]{20,}$/
    const ASSIGNED = new RegExp(`${KEY_VAR}\\s*[:=]\\s*["'\`]?([^\\s"'\`]{8,})`)

    for (const file of files) {
      const body = readText(root, file)
      if (body === null) continue

      const shaped = KEY_SHAPED.exec(body)
      expect(
        shaped?.[0] ?? null,
        `\`${file}\` contains something shaped like a Resend API key. #51: "Never in git — ` +
          "this repo is public.\" Rotate it at the provider AND treat the commit as public " +
          "permanently; it cannot be removed from forks or caches by a follow-up commit.",
      ).toBeNull()

      const assigned = ASSIGNED.exec(body)
      if (assigned && !PLACEHOLDER.test(assigned[1]) && CREDENTIAL_SHAPED.test(assigned[1])) {
        expect(
          `${file}: ${assigned[0]}`,
          `\`${KEY_VAR}\` is assigned a literal value in a tracked file. It is a secret: ` +
            "`wrangler secret put RESEND_API_KEY`, per #51 and CLAUDE.md § Secrets. Naming the " +
            "variable is fine; giving it a value here is not.",
        ).toBe("")
      }
    }

    // TODO(test-author): this cannot prove the key IS installed as a secret —
    // `wrangler secret list` needs an authenticated account and this suite runs
    // offline against a local `wrangler dev` (tests/acceptance/README.md: "no
    // live fleet, no network"). It proves only the half that matters
    // irreversibly: that the key is not in the repository.
  })

  test("the address a customer reads is the configured one, in every delivery state", async ({
    page,
    request,
  }) => {
    // The runtime half of #51's `EMAIL_FROM` clause. The test above asserts the
    // value is declared as configuration; this asserts the running Worker
    // actually sends from it — a var declared and then ignored in favour of the
    // literal it was supposed to replace would satisfy neither #51 nor the
    // finding on #14 that motivated it.
    //
    // Asserted across all three delivery states because #51 is the seam that
    // hands the message to the provider: contract § "Delivery state vocabulary"
    // makes `queued → sent` and `queued → failed` the only transitions, and the
    // sender must be the same configured address on both sides of each, and on
    // neither side may the provider path rewrite it. Every one of
    // `mocks/01-outbox-queued.html`, `02-outbox-sent.html`,
    // `03-outbox-failed.html` and `04-outbox-mixed.html` renders exactly this
    // string in `email-from`.
    test.setTimeout(180_000)

    const declared = declaredEmailFrom(repoRoot())
    expect(
      declared,
      `#51: the rendered sender must be traceable to an \`Env\` var — no \`${FROM_VAR}\` ` +
        "declaration exists in `wrangler.toml` or on `serve:acceptance`, so whatever the page " +
        "renders below is still the hardcoded literal #51 exists to remove. See the config test " +
        "in this slice for the full quote.",
    ).not.toBeNull()
    const configured = (declared as { value: string }).value

    // A row the fake accepts, and a row it never will — the same message, two
    // outcomes, one sender.
    const queuedGood = await queueOneFor(page, request, INBOX.from, 0, 5100, signoffFields())
    const queuedBad = await queueOneFor(page, request, INBOX.fromFailed, 1, 5110, {
      question: QUESTION,
      status: "needs-input",
    })

    for (const [row, who] of [
      [queuedGood, INBOX.from],
      [queuedBad, INBOX.fromFailed],
    ] as Array<[Row, string]>) {
      expect(
        row.from,
        `${who}, while \`queued\`: the sender is the configured \`${FROM_VAR}\`, which the ` +
          "acceptance environment pins to the contract's literal",
      ).toBe(configured)
      expect(row.from, "and that value is the one contract § \"The provider seam\" pins").toBe(
        PINNED_EMAIL_FROM,
      )
    }

    // Drive both rows through the provider seam to their terminal states.
    const deadline = Date.now() + 60_000
    let good: Row | undefined
    let bad: Row | undefined
    while (Date.now() < deadline) {
      await runDrain(request)
      await sleep(1_000)

      await asCustomer(page, INBOX.from)
      good = (await readOutbox(page, INBOX.from))[0]
      await asCustomer(page, INBOX.fromFailed)
      bad = (await readOutbox(page, INBOX.fromFailed))[0]

      if (
        good &&
        bad &&
        TERMINAL.includes(good.status as DeliveryStatus) &&
        TERMINAL.includes(bad.status as DeliveryStatus)
      ) {
        break
      }
    }

    expect(
      good?.status,
      `${INBOX.from} contains no \`${FAKE_FAILS}\` substring, so the provider accepts it — ` +
        "contract § \"Retry/backoff budget\" bounds this at 60 seconds of `GET /__scheduled` " +
        "polling",
    ).toBe("sent")
    expect(
      bad?.status,
      `${INBOX.fromFailed} contains \`${FAKE_FAILS}\`, so the provider never accepts it — ` +
        "contract § \"The provider seam\" pins that the fake \"deterministically fails every " +
        "call\" for such a recipient, and contract § \"Retry/backoff budget\" bounds the arc to " +
        "`failed` at 60 seconds",
    ).toBe("failed")

    expect(
      good?.pillText,
      'contract § vocabulary: `sent` ⇒ the pill reads exactly "Sent"',
    ).toBe(STATUS_TEXT.sent)
    expect(
      bad?.pillText,
      'contract § vocabulary: `failed` ⇒ the pill reads exactly "Delivery failed"',
    ).toBe(STATUS_TEXT.failed)

    // The point of the test: delivery changed the row's state, and changed
    // nothing about who it came from.
    expect(
      good?.from,
      "a delivered message came from the configured sender — the provider seam records an " +
        "outcome, it does not rewrite the envelope",
    ).toBe(configured)
    expect(
      bad?.from,
      "a message that could not be delivered still came from the configured sender — a failure " +
        "path that falls back to a different (or missing) `From` is exactly the per-environment " +
        "hazard #51's `EMAIL_FROM` clause exists to remove",
    ).toBe(configured)

    // TODO(test-author): this cannot show that the address was handed to the
    // provider, only that it is what the portal renders — contract § "The
    // provider seam" says the suite "never imports or calls `MailProvider`
    // directly", and #51's recording fake, which is precisely the artefact that
    // would answer "what would have been sent", has no pinned read surface.
    // See this file's header.
  })

  test("a recipient the provider can never accept is never reported as delivered", async ({
    page,
    request,
  }) => {
    // #51's fail-closed clause, first half: "An unset or invalid
    // `RESEND_API_KEY` must leave rows `queued` and record an error — never
    // silently succeed… 'The gate is off because the secret is missing' is the
    // failure mode that looks identical to 'everything is fine' until a customer
    // asks why they heard nothing."
    //
    // #50's slice asserts the ENDPOINT of that arc (a `mailfail` row ends
    // `failed`). This asserts the property that has to hold at every point ALONG
    // it, which an endpoint check cannot see: a send the provider never accepted
    // is never, at any observation, reported as `Sent`. A seam that optimistically
    // marks `sent` and corrects itself on the next tick would pass #50's slice
    // and is precisely the "looks identical to everything is fine" failure.
    test.setTimeout(180_000)

    await queueOneFor(page, request, INBOX.stalls, 2, 5120, { status: "shipped" })

    const observations: string[] = []
    const deadline = Date.now() + 60_000
    let row: Row | undefined

    while (Date.now() < deadline) {
      await runDrain(request)
      await sleep(1_000)

      const rows = await readOutbox(page, INBOX.stalls)
      expect(
        rows.length,
        "the provider seam neither duplicates nor drops the row it is failing to send",
      ).toBe(1)
      row = rows[0]
      observations.push(row.status ?? "<no data-status>")

      expect(
        row.status,
        `after ${observations.length} drain run(s) the row read \`${row.status}\`. The whole ` +
          "observed arc so far: " +
          `${observations.join(" → ")}. A message the provider never accepted must NEVER be ` +
          "reported as delivered, not even transiently — #51: \"never silently succeed\".",
      ).not.toBe("sent")

      // While it is still trying, contract § vocabulary is explicit that the row
      // is `queued` and nothing else: "a fixed set" of three slugs, and
      // `queued → sent` or `queued → failed` are the only transitions there are.
      expect(
        Object.keys(STATUS_TEXT),
        `observation ${observations.length}: contract § vocabulary is a fixed set of three slugs`,
      ).toContain(row.status)

      if (row.status === "failed") break
    }

    expect(
      row?.status,
      "contract § \"Retry/backoff budget\" bounds the give-up arc: a permanently unsendable row " +
        `must reach \`failed\` inside 60 seconds of polling \`GET ${DRAIN}\`. Observed: ` +
        `${observations.join(" → ") || "<nothing>"}`,
    ).toBe("failed")

    // "…and record an error." The customer's rendering of it is customer-safe
    // copy (#49/#50 own that wall); what #51 owns is that an error was recorded
    // at all rather than the row quietly going terminal with nothing to show.
    expect(
      row?.lastError,
      "contract § hooks: `delivery-last-error` is present if and only if the row is `failed`, " +
        "and #51 requires the failure to \"record an error\" rather than fail silently",
    ).not.toBeNull()
    expect(
      (row?.lastError ?? "").length,
      "an error that renders as an empty string is a silent failure with extra steps",
    ).toBeGreaterThan(0)
    expect(
      row?.attempts,
      "contract § hooks: `delivery-attempts` is present if and only if the row is `failed`",
    ).not.toBeNull()

    // The mirror image of "never silently succeed": a row that failed carries no
    // delivery time. Contract § hooks pins `delivery-sent-at` as present "if and
    // only if `data-status=\"sent\"`" — a delivery timestamp on a failed row is a
    // false success by another name.
    expect(
      row?.sentAt,
      "contract § hooks: `delivery-sent-at` is present if and only if the row is `sent`, so a " +
        "row that gave up must show no delivery time at all",
    ).toBeNull()
  })

  test("a provider that never works wedges neither the scheduled handler nor another customer's mail", async ({
    page,
    request,
  }) => {
    // #51's fail-closed clause, second half: an unset or invalid key must
    // "never crash the scheduled handler."
    //
    // Black-box, "never crash" has two observable halves, and #50's slice —
    // which drives one recipient at a time — sees neither:
    //
    //   1. Every `GET /__scheduled` keeps answering 2xx, and the Worker stays
    //      live for ordinary customer traffic, right through the failing arc and
    //      well past the point the row gives up.
    //   2. The failure is contained to its own row. Another customer's mail,
    //      queued at the same time, still gets sent. A seam that throws out of
    //      the send and takes the drain's loop with it strands every row behind
    //      the bad one — the "stuck notification" #49's own motivating text names,
    //      arriving by a different door.
    test.setTimeout(240_000)

    // Two healthy recipients bracketing an unsendable one, so containment is
    // tested in both directions regardless of the order the drain claims rows.
    await queueOneFor(page, request, INBOX.neighbourA, 0, 5130, signoffFields())
    await queueOneFor(page, request, INBOX.wedges, 1, 5140, {
      question: QUESTION,
      status: "needs-input",
    })
    await queueOneFor(page, request, INBOX.neighbourB, 2, 5150, { status: "shipped" })

    const readAll = async (): Promise<Record<string, Row | undefined>> => {
      const out: Record<string, Row | undefined> = {}
      for (const to of [INBOX.neighbourA, INBOX.wedges, INBOX.neighbourB]) {
        await asCustomer(page, to)
        out[to] = (await readOutbox(page, to))[0]
      }
      return out
    }

    const settled = (seen: Record<string, Row | undefined>) =>
      [INBOX.neighbourA, INBOX.wedges, INBOX.neighbourB].every((to) =>
        TERMINAL.includes(seen[to]?.status as DeliveryStatus),
      )

    let seen: Record<string, Row | undefined> = {}
    let ticks = 0
    const deadline = Date.now() + 60_000

    while (Date.now() < deadline) {
      const drain = await request.get(DRAIN)
      ticks++
      expect(
        drain.ok(),
        `drain run ${ticks} answered HTTP ${drain.status()}. ${DRAIN_UNAVAILABLE} #51: a send ` +
          "that cannot succeed must \"never crash the scheduled handler\" — a cron whose handler " +
          "throws is a queue that stops draining for every customer at once.",
      ).toBe(true)

      // The Worker is still serving ordinary traffic between ticks, not wedged.
      const health = await request.get(HEALTH)
      expect(
        health.ok(),
        `after drain run ${ticks}, \`GET ${HEALTH}\` answered HTTP ${health.status()} — a failing ` +
          "provider must not take the Worker down with it",
      ).toBe(true)

      await sleep(1_000)
      seen = await readAll()
      if (settled(seen)) break
    }

    expect(
      seen[INBOX.wedges]?.status,
      `the \`${FAKE_FAILS}\` recipient must reach \`failed\` inside the 60-second bound ` +
        `contract § "Retry/backoff budget" sets (${ticks} drain runs fired)`,
    ).toBe("failed")

    for (const neighbour of [INBOX.neighbourA, INBOX.neighbourB]) {
      expect(
        seen[neighbour]?.status,
        `${neighbour} contains no \`${FAKE_FAILS}\` substring, so the provider accepts it — a ` +
          "permanently failing send for a DIFFERENT customer must not strand this one. If this " +
          `reads \`queued\` while ${INBOX.wedges} reads \`failed\`, the send loop is aborting on ` +
          "the first provider error instead of recording it and moving on.",
      ).toBe("sent")
      expect(
        seen[neighbour]?.sentAt,
        "contract § hooks: a `sent` row shows a delivery time, and it must be non-empty",
      ).not.toBeNull()
    }

    // Past the give-up point, the handler keeps answering. #50's slice asserts
    // the row stays terminal; this asserts the HANDLER stays healthy — a seam
    // that throws on a row it can no longer retry is still a crashed cron.
    for (let i = 0; i < 5; i++) {
      const drain = await request.get(DRAIN)
      expect(
        drain.ok(),
        `post-give-up drain run ${i + 1} answered HTTP ${drain.status()} — the cron fires on a ` +
          "schedule forever, long after every row it can send has been sent",
      ).toBe(true)
      const health = await request.get(HEALTH)
      expect(health.ok(), "and the Worker is still serving customer traffic").toBe(true)
    }

    // NO LEAK. #49 and #50 assert a vocabulary wall on `delivery-last-error`
    // (contract § "Customer-safe error copy"), which is a list of words. This is
    // the one thing a word-list cannot catch: the credential itself, or the
    // variable that holds it, arriving on a customer's screen because a
    // fail-closed error string was rendered verbatim. Contract § "Customer-safe
    // error copy" names exactly that string as the DB's content — "RESEND_API_KEY
    // unset" — while requiring it never be what the customer reads.
    await asCustomer(page, INBOX.wedges)
    await page.goto(OUTBOX)
    const rendered = await page.content()
    expect(
      rendered,
      `\`${KEY_VAR}\` appears on a customer-facing page. Contract § "Customer-safe error copy": ` +
        "`delivery-last-error`'s rendered text is not `outbox.last_error` verbatim — the DB " +
        "column holds \"whatever the provider or an unset key produced (… \\\"RESEND_API_KEY " +
        "unset\\\" …), which is operator-debugging material, not customer copy.\"",
    ).not.toContain(KEY_VAR)
    expect(
      rendered,
      "something shaped like a Resend API key was rendered to a customer. A credential that " +
        "reaches a browser is disclosed; #51 puts the key behind `wrangler secret put` precisely " +
        "so it lives in exactly one place.",
    ).not.toMatch(/\bre_[A-Za-z0-9_-]{16,}/)
    expect(
      rendered,
      "an `Authorization: Bearer …` header fragment reached a customer-facing page — that is the " +
        "single `fetch` #51 describes leaking its own credential material into the error it records",
    ).not.toMatch(/Bearer\s+[A-Za-z0-9_.\-]{8,}/)
  })
})
