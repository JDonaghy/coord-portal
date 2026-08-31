import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { insertClientRow, insertProjectRow, insertSubmissionRow } from "./client-fixtures"

/**
 * Black-box coverage for issue #163 ([portal] EM-3: the inbound router),
 * driving the real Worker under `wrangler dev` with real local D1 — see
 * `playwright.config.ts`. This is the project's own `e2e/` tier, not the sealed
 * acceptance suite under `tests/acceptance/`; per CLAUDE.md this repo still
 * ships its own behavioural coverage for behaviour-changing work, and the
 * sealed suite's independence is exactly why it does not substitute for this
 * file.
 *
 * WHAT THIS FILE IS FOR, THAT `test/inboundRouter.test.ts` IS NOT.
 * That file drives `decideRoute` — the pure core — over hand-built
 * `RoutingLookup` fixtures, so it proves the *ladder* is right. It cannot prove
 * the router is wired to anything: for the whole of #163's first implementation
 * pass the module existed, its unit tests were green, and every
 * `inbound_emails.routed_*` column was still `NULL`, because nothing called it.
 * Everything below goes through `POST /__email`
 * (`src/routes/inboundTestDoor.ts`) — the real `email()` path — and reads the
 * decision back off the recorded row, which is the only thing that would have
 * caught that.
 *
 * `serve:test` does NOT wipe `.wrangler/state` between runs, so every fixture
 * carries a per-run unique identity and every assertion filters the read-back
 * to its own rows — the same trick `e2e/inbound-email.spec.ts` and
 * `e2e/drain.spec.ts` already use.
 *
 * Every address, name, subject and body is invented on the reserved
 * `example.test` TLD (RFC 6761) — CLAUDE.md rule 1: this repo is public and a
 * real customer's words in a commit cannot be taken back.
 */

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "b7d1e3a95c26401f8ae04c73b19d258f.access",
  "CF-Access-Client-Secret":
    "5c8e1b0a3f7d92e4b16c85f0a37d9e4b2c6108f5a39d7e2b4c6018a3f7d92e4b",
}

function tag(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function uniqueEmail(local: string): string {
  return `${local}-${tag()}@sender.example.test`
}

interface BlobOptions {
  from: string
  to?: string
  subject?: string
  messageId: string
  /** A `dmarc=` verdict for the `Authentication-Results` header. Omit for no header at all. */
  dmarc?: "pass" | "fail"
  extraHeaders?: Record<string, string>
  body?: string
}

function blob(options: BlobOptions): string {
  const headers = [
    `From: Fixture Sender <${options.from}>`,
    `To: ${options.to ?? "intake@mail.example.test"}`,
    `Subject: ${options.subject ?? "About the booking screen"}`,
    "Date: Tue, 25 Aug 2026 09:14:00 +0000",
    `Message-ID: <${options.messageId}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
  ]
  if (options.dmarc !== undefined) {
    headers.push(`Authentication-Results: mx.example.test; dmarc=${options.dmarc} header.from=sender.example.test`)
  }
  for (const [key, value] of Object.entries(options.extraHeaders ?? {})) {
    headers.push(`${key}: ${value}`)
  }
  return `${headers.join("\r\n")}\r\n\r\n${options.body ?? "Could we move the date picker above the fold?"}\r\n`
}

/** The `inbound_emails` row as `POST`/`GET /__email` renders it — the `routed_*` half is #163's. */
interface DoorResponse {
  id: string
  disposition: string
  from_email: string
  to_email: string
  subject: string
  auth_result: string
  suppression_reason: string | null
  routed_kind: string | null
  routed_rung: number | null
  routed_reason: string | null
  routed_runner_up: string | null
}

/**
 * Delivers one message through the real `email()` path. The envelope recipient
 * is passed out of band (`?to=`) precisely because rung 1 reads it and not the
 * `To:` header — see `src/routes/inboundTestDoor.ts`.
 */
async function deliver(
  request: APIRequestContext,
  options: BlobOptions & { envelopeTo?: string },
): Promise<DoorResponse> {
  const params = new URLSearchParams({
    to: options.envelopeTo ?? options.to ?? "intake@mail.example.test",
    from: options.from,
  })
  const res = await request.post(`/__email?${params.toString()}`, {
    data: blob(options),
    headers: { "content-type": "message/rfc822" },
  })
  expect(res.status(), "POST /__email must exist under MAIL_PROVIDER=fake").toBe(200)
  return (await res.json()) as DoorResponse
}

/** Every routed decision is a complete one: an operator gets a sentence, not a slug. */
function expectReadableReason(row: DoorResponse) {
  expect(row.routed_reason, "a routed row always carries a human-readable reason").not.toBeNull()
  expect((row.routed_reason ?? "").length, "the reason is a sentence, not a slug").toBeGreaterThan(20)
}

async function seedSubmission(page: Page, email: string, outcome: string) {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(outcome)
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The inbound-router e2e suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const url = page.url()
  return {
    url,
    id: url.split("/submissions/")[1] ?? "",
    reference: (await page.getByTestId("submission-reference").innerText())
      .trim()
      .replace(/^Reference\s+/, ""),
  }
}

// ── RUNG 1 — the address it was delivered to ─────────────────────────────────

test("rung 1 — a plus-addressed envelope recipient routes to that thread", async ({ page, request }) => {
  const owner = uniqueEmail("router-rung1")
  const submission = await seedSubmission(page, owner, "A first request, for the rung 1 plus-address case.")

  const row = await deliver(request, {
    from: owner,
    messageId: `rung1-${tag()}@sender.example.test`,
    // The `To:` header deliberately disagrees with the envelope: rung 1 reads
    // the envelope recipient, which is the one an attacker cannot forge.
    to: "hello@mail.example.test",
    envelopeTo: `intake+${submission.reference}@mail.example.test`,
    subject: "Re: your request",
  })

  expect(row.routed_rung, "the plus-address token names a real thread").toBe(1)
  expect(row.routed_kind).toBe("message")
  expectReadableReason(row)
  expect(row.routed_runner_up, "rung 1 is an exact match — nothing to be a runner-up to").toBeNull()
})

test("rung 1 is not gated on DMARC — the envelope recipient is not a forgeable header", async ({
  page,
  request,
}) => {
  const owner = uniqueEmail("router-rung1-dmarc")
  const submission = await seedSubmission(page, owner, "A request whose reply will fail DMARC outright.")

  const row = await deliver(request, {
    from: owner,
    dmarc: "fail",
    messageId: `rung1fail-${tag()}@sender.example.test`,
    envelopeTo: `intake+${submission.reference}@mail.example.test`,
  })

  expect(row.auth_result).toBe("fail")
  expect(row.routed_rung, "rungs 1 and 2 are deliberately not behind the DMARC gate").toBe(1)
  expect(row.routed_kind).toBe("message")
})

// ── RUNG 2 — a reference quoted in the subject or body ───────────────────────

test("rung 2 — a SUB-XXXXXX quoted in the body routes there, quoted original and all", async ({
  page,
  request,
}) => {
  const owner = uniqueEmail("router-rung2-body")
  const submission = await seedSubmission(page, owner, "A request whose reference gets quoted back at us.")

  const row = await deliver(request, {
    // A *different* address from the one that filed it: the reference is the
    // proof here, not the sender's claimed identity.
    from: uniqueEmail("router-rung2-other"),
    messageId: `rung2body-${tag()}@sender.example.test`,
    subject: "a question",
    body: [
      "Any movement on this?",
      "",
      "> On Tuesday we wrote:",
      `> Thanks — your reference is ${submission.reference}.`,
    ].join("\n"),
  })

  expect(row.routed_rung, "a reference buried in the quoted original still counts").toBe(2)
  expect(row.routed_kind).toBe("message")
  expectReadableReason(row)
  expect(row.routed_runner_up, "rung 2 is an exact match — no runner-up").toBeNull()
})

test("rung 2 — a SUB-XXXXXX quoted in the subject line routes there too", async ({ page, request }) => {
  const owner = uniqueEmail("router-rung2-subject")
  const submission = await seedSubmission(page, owner, "A request whose reference ends up in a subject line.")

  const row = await deliver(request, {
    from: uniqueEmail("router-rung2-subject-other"),
    messageId: `rung2subj-${tag()}@sender.example.test`,
    subject: `Re: [${submission.reference}] the booking screen`,
    body: "No reference down here at all.",
  })

  expect(row.routed_rung).toBe(2)
  expect(row.routed_kind).toBe("message")
})

/**
 * The regression this exists for: the router's reference pattern originally
 * accepted only `[0-9A-F]{6}` — today's `randomHex` mint — while the format
 * every route, mock and contract in this repo pins is `[A-Z0-9]{6}`. A
 * reference outside the narrower alphabet was silently not seen at all, and the
 * message fell to rung 6 looking like an ordinary stranger rather than like a
 * bug.
 */
test("a quoted reference outside today's hex mint is still recognised as a reference", async ({
  request,
}) => {
  const row = await deliver(request, {
    from: uniqueEmail("router-alphabet"),
    dmarc: "pass",
    messageId: `alphabet-${tag()}@sender.example.test`,
    subject: "picking up an old thread",
    // `HT5JXD` is well-formed under the pinned `[A-Z0-9]` alphabet and names
    // nothing real. A *recognised but unresolvable* SUB- token falls through
    // the ladder; what must never happen is it being invisible to rung 2 for
    // the wrong reason.
    body: "You gave me LEAD-HT5JXD when I first wrote in.",
  })

  expect(row.routed_rung, "a LEAD- token in the pinned alphabet resolves at rung 2").toBe(2)
  expect(row.routed_kind).toBe("lead")
  expectReadableReason(row)
})

// ── RUNG 3 — a known client, one project, matched via cc_emails ─────────────
//
// A `clients` row with a `projects` row linked to it is only ever produced,
// through this app's own HTTP surface, by lead promotion (ms-4). Driving that
// full flow just to get a fixture here would make this coverage depend on
// ms-4's UI mechanics — `client-fixtures.ts` seeds the same three tables
// directly instead, the same posture `outbox-fixtures.ts` already takes and
// the same one the sealed acceptance slice for this issue
// (`tests/acceptance/ms-5/163-inbound-router.spec.ts`) takes for these exact
// tables. See that file's own doc comment for the fuller rationale.

test("rung 3 — a cc_emails match resolves a single-project known client, even via a long address with % and _", async ({
  request,
}) => {
  const primaryEmail = uniqueEmail("router-rung3-primary")
  // Deliberately long (well past D1's 50-character LIKE-pattern cap the
  // router's `getClientRecordByCcEmail` used to crash on) and carrying both
  // `%` and `_` — both legal in a local part, and both `LIKE` wildcards. This
  // is the regression #313 found: the fix moved to `instr()`, which has
  // neither a length cap nor metacharacters. See `src/clients.ts`'s own doc
  // on `getClientRecordByCcEmail` for the full story.
  const ccEmail = `cc-with-percent%and_underscore-and-quite-a-bit-of-extra-length-${tag()}@sender.example.test`
  const otherCc = uniqueEmail("router-rung3-other-cc")
  const client = insertClientRow(primaryEmail, `${otherCc}, ${ccEmail}`)
  const project = insertProjectRow({ clientId: client, customerEmail: primaryEmail, name: "Solo Project" })
  insertSubmissionRow({ customerEmail: primaryEmail, projectId: project })

  const row = await deliver(request, {
    from: ccEmail, // the cc address, not the client's own primary email
    dmarc: "pass",
    messageId: `rung3-${tag()}@sender.example.test`,
    subject: "checking in",
    body: "How is this coming along?",
  })

  expect(row.routed_rung, "getClientRecordByEmail found nothing, but cc_emails did").toBe(3)
  expect(row.routed_kind).toBe("message")
  expectReadableReason(row)
  expect(row.routed_runner_up, "rung 3 is an exact match — no runner-up").toBeNull()
})

/**
 * The exact shape #313 found: `LIKE` reads `_` as "any one character," so a
 * `cc_emails` entry of `a_b@…` used to also match a sender of `axb@…` — a
 * stranger silently resolved to somebody else's client record. `instr()` is a
 * plain substring search with no such wildcard, so a one-character difference
 * must remain a miss.
 */
test("a cc_emails entry is matched literally — a wildcard-shaped near-miss does not resolve", async ({
  request,
}) => {
  const primaryEmail = uniqueEmail("router-rung3-literal-primary")
  const ccLocal = `a_b-router-rung3-${tag()}`
  const ccEmail = `${ccLocal}@sender.example.test`
  const nearMiss = `${ccLocal.replace("_", "x")}@sender.example.test` // differs by exactly the `_` position

  const client = insertClientRow(primaryEmail, ccEmail)
  const project = insertProjectRow({ clientId: client, customerEmail: primaryEmail, name: "Literal Match Project" })
  insertSubmissionRow({ customerEmail: primaryEmail, projectId: project })

  const row = await deliver(request, {
    from: nearMiss,
    dmarc: "pass",
    messageId: `rung3literal-${tag()}@sender.example.test`,
    subject: "checking in",
    body: "How is this coming along?",
  })

  expect(
    row.routed_rung,
    "a near-miss address one character off a cc_emails entry must not resolve to that client",
  ).toBe(6)
  expect(row.routed_kind).toBe("lead")
})

// ── RUNG 4 — a known client, several projects, scored ───────────────────────

test("rung 4 — a project awaiting sign-off wins over a merely more recent one", async ({ request }) => {
  const clientEmail = uniqueEmail("router-rung4-multi")
  const client = insertClientRow(clientEmail)

  const loserMarker = tag()
  const winnerMarker = tag()
  const olderTime = new Date(Date.now() - 60_000).toISOString()
  const newerTime = new Date(Date.now() - 1_000).toISOString()

  // The NOT-waiting project is the MORE RECENT one — a naive
  // "most-recent-wins" implementation would pick this one instead.
  const loserProject = insertProjectRow({
    clientId: client,
    customerEmail: clientEmail,
    name: `Loser Marker ${loserMarker}`,
  })
  insertSubmissionRow({ customerEmail: clientEmail, projectId: loserProject, status: "describing", createdAt: newerTime })

  // Older, but waiting on the customer — contract order is
  // [waiting-on-customer, newest-first, word-overlap], in that order, so this
  // one must win despite being older.
  const winnerProject = insertProjectRow({
    clientId: client,
    customerEmail: clientEmail,
    name: `Winner Marker ${winnerMarker}`,
  })
  insertSubmissionRow({
    customerEmail: clientEmail,
    projectId: winnerProject,
    status: "awaiting-signoff",
    createdAt: olderTime,
  })

  const row = await deliver(request, {
    from: clientEmail,
    dmarc: "pass",
    messageId: `rung4-${tag()}@sender.example.test`,
    subject: "Any news?", // no overlap with either project's name
    body: "Following up on where things stand.",
  })

  expect(row.routed_rung, "a known client with several projects is scored, not an exact match").toBe(4)
  expect(row.routed_kind).toBe("message")
  expectReadableReason(row)
  expect(row.routed_runner_up, "more than one candidate was scored").not.toBeNull()
  expect(row.routed_runner_up, "the losing (merely more recent) project is the runner-up").toContain(loserMarker)
  expect(row.routed_runner_up, "the winning project must not itself be reported as the runner-up").not.toContain(
    winnerMarker,
  )
})

test("rung 4 → 6 — an exact tie between two equally-weighted projects falls to unrouted, never guessed", async ({
  request,
}) => {
  const clientEmail = uniqueEmail("router-rung4-tied")
  const client = insertClientRow(clientEmail)
  const tiedTime = new Date(Date.now() - 30_000).toISOString()

  // Same status (neither waiting on the customer), same recency, and neither
  // project's name overlaps at all with the subject below — a genuine
  // three-way tie across every scoring axis the contract pins.
  const projectA = insertProjectRow({ clientId: client, customerEmail: clientEmail, name: "Zeta Program" })
  insertSubmissionRow({ customerEmail: clientEmail, projectId: projectA, status: "describing", createdAt: tiedTime })

  const projectB = insertProjectRow({ clientId: client, customerEmail: clientEmail, name: "Omega Program" })
  insertSubmissionRow({ customerEmail: clientEmail, projectId: projectB, status: "describing", createdAt: tiedTime })

  const row = await deliver(request, {
    from: clientEmail,
    dmarc: "pass",
    messageId: `rung4tie-${tag()}@sender.example.test`,
    subject: "Following up on things",
    body: "Just checking in.",
  })

  expect(
    row.routed_rung,
    "a tie is not a winner — it falls to rung 6 as unrouted, never a silent pick of A or B",
  ).toBe(6)
  expect(row.routed_kind, "a known client's tie is unrouted, not a fabricated lead").toBe("unrouted")
  expectReadableReason(row)
  expect(
    row.routed_runner_up,
    "this is a known client (unlike a total stranger), so there is something to be a runner-up to",
  ).not.toBeNull()
})

// ── RUNG 5 — a returning sender with no `clients` row ────────────────────────

test("rung 5 — a returning sender with history but no clients row scores their own projects", async ({
  page,
  request,
}) => {
  const sender = uniqueEmail("router-rung5")

  // Two independent requests through /intake: 0016 backfilled nothing, so both
  // carry a bare `customer_email` with `client_id IS NULL` — exactly rung 5's
  // stated shape.
  await seedSubmission(page, sender, "A first independent request about the booking screen.")
  await seedSubmission(page, sender, "A second, unrelated request about the invoice export.")

  const row = await deliver(request, {
    from: sender,
    dmarc: "pass",
    messageId: `rung5-${tag()}@sender.example.test`,
    subject: "one more thing",
    body: "No reference quoted anywhere in here.",
  })

  expect(row.routed_rung, "the address matches history even with no clients row").toBe(5)
  expect(row.routed_kind).toBe("message")
  expectReadableReason(row)
  expect(row.routed_runner_up, "two candidates were scored — the loser is recorded").not.toBeNull()
})

/**
 * A follow-up is the one path that mints a `projects` row (#109), and it mints
 * one with `client_id IS NULL` — the shape rung 5 has to score *through*
 * `getProjectsByIds` rather than over bare submissions.
 */
test("rung 5 scores a project-bearing history, not just loose submissions", async ({ page, request }) => {
  const sender = uniqueEmail("router-rung5-project")
  const first = await seedSubmission(page, sender, "A first round that will be shipped and followed up.")

  const push = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: first.reference, revision: 1, fields: { status: "shipped" } }] },
    headers: SERVICE_TOKEN,
  })
  expect(push.status(), "the bridge push that ships the first round must be accepted").toBe(200)

  await page.goto(first.url)
  await page.getByTestId("start-follow-up").click()
  await page.getByTestId("field-outcome").fill("A second round, following up on the first.")
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The follow-up groups into one project.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const row = await deliver(request, {
    from: sender,
    dmarc: "pass",
    messageId: `rung5proj-${tag()}@sender.example.test`,
    subject: "checking in on the follow-up",
    body: "No reference quoted here either.",
  })

  expect(row.routed_rung, "a history that runs through a project still resolves at rung 5").toBe(5)
  expect(row.routed_kind).toBe("message")
  expectReadableReason(row)
})

// ── RUNG 6 — the safe default, and the two ways of reaching it ───────────────

test("rung 6 — nobody we know at all becomes a lead, with no runner-up to speak of", async ({
  request,
}) => {
  const row = await deliver(request, {
    from: uniqueEmail("router-stranger"),
    dmarc: "pass",
    messageId: `stranger-${tag()}@sender.example.test`,
    subject: "hello, is this the right address?",
    body: "I saw your site and wanted to ask about a project.",
  })

  expect(row.routed_rung, "no reference, no client, no history — the safe default").toBe(6)
  expect(row.routed_kind).toBe("lead")
  expectReadableReason(row)
  expect(row.routed_runner_up, "a stranger has nothing to be a runner-up to").toBeNull()
})

/**
 * "Anyone can put any address in a `From:` header." A message whose sender has
 * real history must still fall to rung 6 without a DMARC pass — and to
 * `unrouted`, never `lead`, because inventing a fresh lead for someone who may
 * already be a customer is the split-brain CLAUDE.md's ownership rule warns
 * about.
 */
test("a DMARC failure parks a would-be rung 5 match as unrouted, never as a match", async ({
  page,
  request,
}) => {
  const sender = uniqueEmail("router-dmarc-fail")
  await seedSubmission(page, sender, "A request whose sender will later fail DMARC.")

  const row = await deliver(request, {
    from: sender,
    dmarc: "fail",
    messageId: `dmarcfail-${tag()}@sender.example.test`,
    subject: "following up",
    body: "No reference quoted anywhere.",
  })

  expect(row.auth_result).toBe("fail")
  expect(row.routed_rung, "rungs 3-5 only fire on a DMARC pass").toBe(6)
  expect(row.routed_kind, "unrouted, so a human looks at it — not a fabricated lead").toBe("unrouted")
  expectReadableReason(row)
})

test("an absent Authentication-Results header is treated exactly like a failure", async ({
  page,
  request,
}) => {
  const sender = uniqueEmail("router-dmarc-none")
  await seedSubmission(page, sender, "A request whose reply carries no auth header at all.")

  const row = await deliver(request, {
    from: sender,
    messageId: `dmarcnone-${tag()}@sender.example.test`,
    subject: "following up",
    body: "No reference quoted anywhere.",
  })

  expect(row.auth_result).toBe("none")
  expect(row.routed_rung).toBe(6)
  expect(row.routed_kind).toBe("unrouted")
})

// ── SUPPRESSED MAIL IS NEVER ROUTED ──────────────────────────────────────────

/**
 * #161's rule, which #163 must not quietly undo: a suppressed message is
 * "recorded, with a reason; no draft, **no routing**". All four routing columns
 * stay `NULL` — an auto-responder must never be resolved to a person, and an
 * operator must never be shown a routing decision that was never really made.
 */
test("a suppressed message is recorded with no routing decision at all", async ({ page, request }) => {
  const sender = uniqueEmail("router-suppressed")
  // Real history, so the only thing keeping it out of the router is suppression.
  await seedSubmission(page, sender, "A request whose sender later sends an auto-reply.")

  const row = await deliver(request, {
    from: sender,
    dmarc: "pass",
    messageId: `suppressed-${tag()}@sender.example.test`,
    extraHeaders: { "Auto-Submitted": "auto-replied" },
    subject: "Out of office",
    body: "I am away until Monday.",
  })

  expect(row.disposition).toBe("suppressed")
  expect(row.suppression_reason).toBe("auto-submitted")
  expect(row.routed_kind, "a machine is never routed to a person").toBeNull()
  expect(row.routed_rung).toBeNull()
  expect(row.routed_reason).toBeNull()
  expect(row.routed_runner_up).toBeNull()
})

// ── THE DECISION IS DURABLE, NOT JUST IN THE RESPONSE ────────────────────────

test("the routing decision is persisted on the row, and a redelivery does not re-decide it", async ({
  request,
}) => {
  const messageId = `durable-${tag()}@sender.example.test`
  const sender = uniqueEmail("router-durable")
  const envelopeTo = `intake-${tag()}@mail.example.test`

  const first = await deliver(request, {
    from: sender,
    dmarc: "pass",
    messageId,
    envelopeTo,
    subject: "hello there",
    body: "A first contact from a stranger.",
  })
  expect(first.routed_rung).toBe(6)
  expect(first.routed_kind).toBe("lead")

  const again = await deliver(request, {
    from: sender,
    dmarc: "pass",
    messageId,
    envelopeTo,
    subject: "hello there",
    body: "A first contact from a stranger.",
  })
  expect(again.id, "a redelivery converges on the row that already exists").toBe(first.id)

  const res = await request.get("/__email")
  expect(res.ok()).toBe(true)
  const { emails } = (await res.json()) as { emails: DoorResponse[] }
  const rows = emails.filter((email) => email.id === first.id)
  expect(rows, "exactly one row, carrying the decision it was recorded with").toHaveLength(1)
  expect(rows[0]?.routed_rung).toBe(6)
  expect(rows[0]?.routed_kind).toBe("lead")
  expect(rows[0]?.routed_reason).toBe(first.routed_reason)
})
