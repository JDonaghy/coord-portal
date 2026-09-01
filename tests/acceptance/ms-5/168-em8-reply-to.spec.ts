import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect, test, type APIRequestContext } from "@playwright/test"

/**
 * ms-5 sealed acceptance slice — issue #168
 * "[portal] EM-8: converge reply routing — plus-addressed Reply-To so
 *  replies thread themselves"
 *
 * Written from `tests/acceptance/ms-5/contract.md` § "Reply-To on outbound
 * mail" (issue #168, confirmed by amendment), § "The router ladder — full
 * six rungs" (rung 1, already pinned and now confirmed to be fed by EM-8's
 * own output too), and issue #168's own text, without sight of any
 * implementation.
 *
 * ── WHAT #168 OWNS, PER THE CONTRACT'S OWN THREE BULLETS ─────────────────
 *
 *   1. "Every outbound notification carries a Reply-To bearing its own
 *      submission reference, observable on the recorded fake payload via
 *      `GET /__outbound`."
 *   2. "A reply delivered to that address routes by rung 1 to that exact
 *      submission."
 *   3. "A row with no submission reference (should not occur) sends with
 *      the plain configured address rather than a malformed one — absent
 *      beats broken, the same rule `replyTo` and `html` already follow at
 *      that seam."
 *
 * This slice has exactly one test per bullet.
 *
 * ── WHY THIS SLICE NEVER PINS AN ACCEPTANCE-ENVIRONMENT `REPLY_TO` LITERAL ──
 *
 * Issue #168's own "The one thing to get right": "The acceptance environment
 * must not follow production here… Changing the production value must not
 * come with an edit to `tests/acceptance/**` — that is amending the oracle to
 * match the implementation, which is the one thing the sealed suite exists to
 * prevent." Contract § "Reply-To on outbound mail" repeats this in its own
 * words: "This contract does not pin a specific acceptance-environment
 * `REPLY_TO` literal (none is given…) — an implementer must not touch
 * anything under `tests/acceptance/` to make this land, full stop."
 *
 * Every assertion below is therefore either (a) purely relational — "this
 * row's own reference appears in its own Reply-To, and a DIFFERENT row's
 * doesn't" — which needs no literal at all, or (b) a round trip that feeds
 * the WORKER's OWN computed Reply-To value straight back into `POST /__email`
 * without this test ever constructing or assuming the address itself. Test 3
 * (the no-reference fallback) is deliberately the loosest of the three for
 * the same reason — see its own comment.
 *
 * ── WHY THIS SLICE SEEDS `submissions`/`outbox`/`inbound_emails` DIRECTLY ────
 *
 * Same posture `ms-5/162-outbox-approval.spec.ts` and
 * `ms-5/165-em5-known-client-thread.spec.ts` already take: #168 is a change
 * to `src/drain.ts`'s own per-row resolution, not to how a row gets INTO
 * `outbox` in the first place (that is #14/#162/#164/#165's own, already
 * sealed, machinery). Seeding `outbox` rows directly isolates this slice from
 * the intake form, the bridge push and the `/replies` approval UI, none of
 * which #168 touches.
 *
 * ── NOT COVERED HERE, AND WHY ────────────────────────────────────────────
 *  - **The exact acceptance `REPLY_TO` literal, or whether it differs from
 *    production's.** Contract § "Reply-To on outbound mail" explicitly
 *    declines to pin one — see above.
 *  - **The exact mechanism a row with no submission reference falls back
 *    through** (whether it reads a distinct config var, a stripped form of
 *    the templated one, or something else). TODO(test-author): #168's own
 *    text and the contract both pin the OBSERVABLE outcome ("the plain
 *    configured address rather than a malformed one") but neither names the
 *    mechanism precisely enough to assert an exact string here without
 *    inventing one. Test 3 asserts the checkable half: never malformed.
 *  - **`wrangler.toml`'s `REPLY_TO` comment wording.** Issue #168 asks for a
 *    comment update ("Update the comment to say what was decided and why");
 *    a code comment is not black-box behaviour and no prior ms contract in
 *    this repo tests comment text.
 *  - **`EM-3`'s own rung-1 routing decision** (reason/runner-up shape,
 *    DMARC-independence) — already sealed by
 *    `ms-5/163-inbound-router.spec.ts`. Test 2 below reuses rung 1, it does
 *    not re-prove it.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and contract § "Synthetic data", every
 * address, name and body below is invented on the reserved `example.test`
 * TLD — never the real `intake@heurontech.com` / `mail.heurontech.com`
 * domains this milestone actually wires up.
 */

test.describe.configure({ timeout: 120_000 })

// ── the repository, as a schema surface (mirrors ms-5/162/163/164/165) ──────

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
      `${process.cwd()} — this slice seeds and reads the migrated local D1`,
  )
}

interface D1Result {
  ok: boolean
  rows: Record<string, unknown>[]
  error: string | null
}

/** Run one statement against the migrated local D1 — read or write. */
function d1(sql: string): D1Result {
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

function escapeSql(value: string): string {
  return value.replace(/'/g, "''")
}

let counter = 0
/** A unique, synthetic label — every row this slice writes owns its own. */
function unique(label: string): string {
  counter += 1
  return `ms5-168-${label}-${Date.now()}-${counter}`
}

function randomToken(n = 6): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let s = ""
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

const SEED_HINT =
  "issue #168 only changes how `src/drain.ts` resolves a `Reply-To` per row — the schema this " +
  "slice seeds against (`submissions`, `outbox`, `inbound_emails`) is earlier, already-shipped " +
  "milestones' own; a failure here points at the acceptance environment's migrations, not #168"

// ── seeding submissions directly (mirrors ms-5/165) ──────────────────────────

function insertSubmission(opts: { customerEmail: string; reference?: string }): { id: string; reference: string } {
  const id = `sub-${unique("sub")}`
  const reference = opts.reference ?? `SUB-${randomToken()}`
  const now = new Date().toISOString()
  const cols = ["id", "reference", "status", "customer_email", "outcome", "audience", "done_definition", "created_at"]
  const vals = [
    id,
    reference,
    "in-progress",
    opts.customerEmail,
    "Synthetic outcome text for the ms-5 #168 acceptance fixture.",
    "Synthetic audience for the ms-5 #168 acceptance fixture.",
    "Synthetic done-definition for the ms-5 #168 acceptance fixture.",
    now,
  ].map((v) => `'${escapeSql(v)}'`)
  const r = d1(`INSERT INTO submissions (${cols.join(", ")}) VALUES (${vals.join(", ")})`)
  expect(r.ok, `seeding a synthetic submission failed (${SEED_HINT}). SQLite said: ${r.error}`).toBe(true)
  return { id, reference }
}

/**
 * `routed_submission_id`'s exact encoding (the submission's own `id`, or its
 * customer-facing `reference`) is not pinned by name anywhere in the
 * contract — mirrors `ms-5/165`'s own `matchesSubmission` helper and its own
 * comment on why both are accepted.
 */
function matchesSubmission(value: string | null, sub: { id: string; reference: string }): boolean {
  return value === sub.id || value === sub.reference
}

// ── seeding outbox rows directly (schema: migrations/0009…0021) ─────────────

let revisionCounter = 1000
function insertOutboxRow(opts: {
  submissionId: string
  emailType?: string
  toEmail: string
  approvalState?: string
}): string {
  const id = `outbox-${unique("row")}`
  const now = new Date().toISOString()
  revisionCounter += 1
  const cols = [
    "id",
    "submission_id",
    "email_type",
    "to_email",
    "from_email",
    "subject",
    "preheader",
    "body",
    "cta_text",
    "cta_href",
    "coord_revision",
    "queued_at",
    "status",
    "attempts",
    "approval_state",
  ]
  const vals = [
    id,
    opts.submissionId,
    opts.emailType ?? "shipped",
    opts.toEmail,
    "notify@example.test",
    "Synthetic subject for the ms-5 #168 acceptance fixture.",
    "Synthetic preheader.",
    "Synthetic body text for the ms-5 #168 acceptance fixture.",
    "View this submission",
    `/submissions/${opts.submissionId}`,
    String(revisionCounter),
    now,
    "queued",
    "0",
    opts.approvalState ?? "not_required",
  ].map((v) => `'${escapeSql(v)}'`)
  const r = d1(`INSERT INTO outbox (${cols.join(", ")}) VALUES (${vals.join(", ")})`)
  expect(r.ok, `seeding a synthetic outbox row failed (${SEED_HINT}). SQLite said: ${r.error}`).toBe(true)
  return id
}

interface OutboxRow {
  id: string
  status: string
  submission_id: string
  to_email: string
}

function outboxRowById(id: string): OutboxRow | null {
  const q = d1(`SELECT * FROM outbox WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as OutboxRow
}

// ── seeding a stranger-shaped inbound_emails row (schema: migrations/0020) ──

/**
 * The shape EM-4's own rung-6 stranger case produces: a `leads` match, no
 * submission at all. Used only as the realistic backdrop for Test 3's
 * no-reference case — this slice does not exercise EM-4's own routing
 * (already sealed by `ms-5/164-em4-stranger-lead.spec.ts`).
 */
function insertStrangerInboundEmail(): string {
  const id = `inbound-${unique("row")}`
  const now = new Date().toISOString()
  const cols = [
    "id",
    "from_email",
    "to_email",
    "subject",
    "body_text",
    "received_at",
    "auth_result",
    "disposition",
    "routed_kind",
    "routed_rung",
  ]
  const vals = [
    id,
    `${unique("stranger")}@example.test`,
    "intake@mail.example.test",
    "Synthetic stranger subject.",
    "Synthetic stranger body.",
    now,
    "none",
    "received",
    "lead",
    "6",
  ].map((v) => `'${escapeSql(v)}'`)
  const r = d1(`INSERT INTO inbound_emails (${cols.join(", ")}) VALUES (${vals.join(", ")})`)
  expect(r.ok, `seeding a synthetic stranger inbound_emails row failed (${SEED_HINT}). SQLite said: ${r.error}`).toBe(
    true,
  )
  return id
}

// ── the drain trigger (mirrors ms-5/162/165, ms-3/50) ────────────────────────

const DRAIN = "/__scheduled"

const DRAIN_UNAVAILABLE =
  `ms-5 issue #168 cannot be observed at all: \`GET ${DRAIN}\` did not answer 2xx. This route is ` +
  "ms-3 issue #50's own trigger for the drain #168's per-row `Reply-To` resolution lives inside " +
  "(`src/drain.ts`), already sealed and green — a failure here means the acceptance environment " +
  "itself is missing `--test-scheduled`, not a #168 defect."

async function runDrain(request: APIRequestContext): Promise<void> {
  const res = await request.get(DRAIN)
  expect(res.ok(), `${DRAIN_UNAVAILABLE} (got HTTP ${res.status()})`).toBe(true)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll a seeded outbox row until it leaves `queued`, or ms-3's own 60s drain budget expires. */
async function drainToTerminal(request: APIRequestContext, id: string, budgetMs = 60_000): Promise<OutboxRow> {
  const deadline = Date.now() + budgetMs
  let row = outboxRowById(id)
  while (Date.now() < deadline) {
    await runDrain(request)
    await sleep(1_000)
    row = outboxRowById(id)
    if (row && row.status !== "queued") return row
  }
  expect(
    row?.status,
    `outbox row ${id} never left \`queued\` inside ${budgetMs}ms of \`GET ${DRAIN}\` polling — the ` +
      "drain is not claiming/sending this row at all, which #168's own `Reply-To` resolution has " +
      "nothing to observe without",
  ).not.toBe("queued")
  return row as OutboxRow
}

// ── the recording fake's read-back (contract § "Reply-To on outbound mail") ─

const OUTBOUND = "/__outbound"

interface RecordedEmail {
  to: string
  from: string
  subject: string
  text: string
  html?: string
  replyTo?: string
}

const OUTBOUND_UNAVAILABLE =
  `ms-5 issue #168 cannot be observed at all: \`GET ${OUTBOUND}\` did not answer 200 with a JSON ` +
  '`{emails: [...]}` body. Contract § "Reply-To on outbound mail" pins this exact route as the ' +
  "read-back for the recording fake's payloads (\"observable on the recorded fake payload via " +
  "`GET /__outbound`\") — ms-3 issue #83's own route, already sealed and green, gated on " +
  '`env.MAIL_PROVIDER === "fake"`, which `serve:acceptance`/`serve:test` already set.'

/** Every payload the fake has recorded for one recipient, in delivery order. */
async function recordedFor(request: APIRequestContext, to: string): Promise<RecordedEmail[]> {
  const res = await request.get(OUTBOUND)
  expect(res.ok(), OUTBOUND_UNAVAILABLE).toBe(true)
  const body = (await res.json().catch(() => null)) as { emails?: RecordedEmail[] } | null
  expect(Array.isArray(body?.emails), OUTBOUND_UNAVAILABLE).toBe(true)
  return (body as { emails: RecordedEmail[] }).emails.filter((e) => e.to === to)
}

// ── the inbound test door (mirrors ms-5/161/163/164/165) ─────────────────────

const EMAIL_DOOR = "/__email"

const DOOR_UNAVAILABLE =
  `ms-5 issue #168's round-trip test cannot run at all: \`POST ${EMAIL_DOOR}\` did not answer with ` +
  "the pinned `{id, disposition}` JSON shape. This door is #161's own, already sealed and landed — " +
  "a failure here means the acceptance environment itself is broken, not a #168 defect."

interface RawMessageOpts {
  from: string
  subject: string
  body: string
  extraHeaders?: Record<string, string>
}

function buildRawMessage(opts: RawMessageOpts): string {
  const headers: string[] = []
  headers.push(`From: ${opts.from}`)
  headers.push(`To: intake@mail.example.test`) // informational only — envelope `to` carries the real target
  headers.push(`Subject: ${opts.subject}`)
  headers.push(`Message-ID: <${unique("msg")}@example.test>`)
  headers.push(`Date: ${new Date().toUTCString()}`)
  headers.push("MIME-Version: 1.0")
  headers.push("Content-Type: text/plain; charset=utf-8")
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) {
    headers.push(`${k}: ${v}`)
  }
  return headers.join("\r\n") + "\r\n\r\n" + opts.body
}

interface DoorResponse {
  id?: unknown
  disposition?: unknown
}

async function deliver(
  request: APIRequestContext,
  envelopeTo: string,
  envelopeFrom: string,
  raw: string,
): Promise<{ id: string; disposition: string }> {
  const qs = new URLSearchParams({ to: envelopeTo, from: envelopeFrom })
  const res = await request.post(`${EMAIL_DOOR}?${qs.toString()}`, {
    data: raw,
    headers: { "content-type": "message/rfc822" },
    failOnStatusCode: false,
  })
  const text = await res.text()
  let body: DoorResponse | null = null
  try {
    body = JSON.parse(text) as DoorResponse
  } catch {
    body = null
  }
  expect(res.status(), `${DOOR_UNAVAILABLE} (got HTTP ${res.status()}, body: ${text})`).toBe(200)
  expect(body, `${DOOR_UNAVAILABLE} (body was not JSON: ${text})`).not.toBeNull()
  expect(typeof body?.id, "the pinned response carries a non-empty id").toBe("string")
  return { id: body?.id as string, disposition: String(body?.disposition) }
}

interface InboundRow {
  id: string
  routed_kind: string | null
  routed_rung: number | null
  routed_submission_id: string | null
}

function inboundRowById(id: string): InboundRow | null {
  const q = d1(`SELECT * FROM inbound_emails WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as InboundRow
}

interface MessageRow {
  id: string
  submission_id: string
  author_role: string
}

function messagesFor(submissionReference: string): MessageRow[] {
  const q = d1(`SELECT * FROM messages WHERE submission_id = '${escapeSql(submissionReference)}'`)
  if (!q.ok) return []
  return q.rows as unknown as MessageRow[]
}

// ── the slice ─────────────────────────────────────────────────────────────

test.describe("ms-5 issue 168 EM-8: converge reply routing on a plus-addressed Reply-To", () => {
  test("every outbound notification carries a Reply-To bearing its own submission's reference, resolved independently per row", async ({
    request,
  }) => {
    // Contract § "Reply-To on outbound mail", bullet 1, and issue #168's own
    // Scope: "REPLY_TO = intake+{submission_reference}@mail.heurontech.com
    // resolved per row at send time in src/drain.ts". Two DIFFERENT
    // submissions, two DIFFERENT outbox rows, drained in the same run — if
    // the Reply-To were still the flat, deployment-wide `env.REPLY_TO` #52
    // left it as (read once, not resolved per row), both rows would carry
    // the SAME value. #168 exists to make that false.
    const subA = insertSubmission({ customerEmail: `${unique("a")}@example.test` })
    const subB = insertSubmission({ customerEmail: `${unique("b")}@example.test` })
    const toA = `${unique("recipient-a")}@example.test`
    const toB = `${unique("recipient-b")}@example.test`

    const rowA = insertOutboxRow({ submissionId: subA.reference, toEmail: toA, emailType: "shipped" })
    const rowB = insertOutboxRow({ submissionId: subB.reference, toEmail: toB, emailType: "needs-input" })

    const sentA = await drainToTerminal(request, rowA)
    const sentB = await drainToTerminal(request, rowB)
    expect(sentA.status, "a row addressed to a recipient with no `mailfail` substring must be sent").toBe("sent")
    expect(sentB.status, "a row addressed to a recipient with no `mailfail` substring must be sent").toBe("sent")

    const recordedA = await recordedFor(request, toA)
    const recordedB = await recordedFor(request, toB)
    expect(recordedA, `exactly one recorded payload for ${toA}`).toHaveLength(1)
    expect(recordedB, `exactly one recorded payload for ${toB}`).toHaveLength(1)

    const replyToA = recordedA[0].replyTo
    const replyToB = recordedB[0].replyTo

    expect(
      replyToA,
      "contract § \"Reply-To on outbound mail\": \"every outbound notification carries a Reply-To " +
        `bearing its own submission reference\" — no Reply-To was recorded at all for ${subA.reference}'s ` +
        "own send",
    ).toBeTruthy()
    expect(replyToB, "same, for the second submission").toBeTruthy()

    // "bearing its own submission reference" — the plus-address scheme rung 1
    // already reads (contract § router ladder, rung 1: "intake+SUB-XXXXXX@…",
    // "now used outbound as well as inbound", contract § "Reply-To on
    // outbound mail"). Local-part only; the domain is deployment
    // configuration this slice deliberately does not pin — see this file's
    // header.
    const ownReference = new RegExp(`\\+${subA.reference}@`)
    expect(
      replyToA,
      `${replyToA} must carry ${subA.reference} as its own plus-addressed local part ` +
        '("intake+SUB-XXXXXX@…", contract § router ladder rung 1)',
    ).toMatch(ownReference)
    const otherReference = new RegExp(`\\+${subB.reference}@`)
    expect(replyToA, "and must NOT carry the OTHER submission's reference").not.toMatch(otherReference)

    const ownReferenceB = new RegExp(`\\+${subB.reference}@`)
    expect(replyToB, `${replyToB} must carry ${subB.reference} as its own plus-addressed local part`).toMatch(
      ownReferenceB,
    )
    const otherReferenceA = new RegExp(`\\+${subA.reference}@`)
    expect(replyToB, "and must NOT carry the OTHER submission's reference").not.toMatch(otherReferenceA)

    // The point of "resolved per row": two rows sent in the same drain tick,
    // for two different submissions, must not collapse onto one shared
    // Reply-To value.
    expect(
      replyToA,
      `row A (${subA.reference}) and row B (${subB.reference}) must carry DIFFERENT Reply-To ` +
        "values — a single flat `env.REPLY_TO` read once (the pre-#168 shape #52 left) would make " +
        "these equal",
    ).not.toBe(replyToB)
  })

  test("a reply delivered to that Reply-To address routes by rung 1 to that exact submission", async ({
    request,
  }) => {
    // Contract § "Reply-To on outbound mail", bullet 2: "A reply delivered to
    // that address routes by rung 1 to that exact submission — this is the
    // same rung 1 already pinned in 'The router ladder,' now confirmed to be
    // fed by EM-8's own output as well as by the original intake link."
    //
    // This is a genuine round trip: the Reply-To value below is never
    // constructed by this test — it is read back from what the WORKER itself
    // computed for this exact row, then handed straight to `POST /__email`'s
    // own envelope recipient unmodified.
    const sub = insertSubmission({ customerEmail: `${unique("customer")}@example.test` })
    const to = `${unique("recipient")}@example.test`
    const row = insertOutboxRow({ submissionId: sub.reference, toEmail: to, emailType: "shipped" })

    const sent = await drainToTerminal(request, row)
    expect(sent.status).toBe("sent")

    const recorded = await recordedFor(request, to)
    expect(recorded, `exactly one recorded payload for ${to}`).toHaveLength(1)
    const replyTo = recorded[0].replyTo
    expect(replyTo, "the send this test round-trips must itself carry a Reply-To").toBeTruthy()

    // A sender who is NOT this submission's own customer — contract § router
    // ladder, rung 1: the envelope's own plus-addressed reference wins over
    // sender-identity resolution (mirrors `ms-5/163`'s and `ms-5/165`'s own
    // rung-1 tests, "beats a contradictory sender identity"). Rung 1 is also
    // pinned as NOT gated on authentication, so a DMARC fail here must not
    // stop it firing either.
    const impersonator = `${unique("impersonator")}@example.test`
    const raw = buildRawMessage({
      from: impersonator,
      subject: "Following up on your message",
      body: "Just replying to the note I got — circling back on this specifically.",
      extraHeaders: { "Authentication-Results": "mx.zohomail.com; dmarc=fail header.from=example.test" },
    })

    const result = await deliver(request, replyTo as string, impersonator, raw)
    expect(
      result.disposition,
      `a reply delivered to the Worker's own computed Reply-To (${replyTo}) must be accepted, not ` +
        "suppressed or rate-limited",
    ).toBe("received")

    const inbound = inboundRowById(result.id) as InboundRow
    expect(
      inbound.routed_rung,
      `contract § router ladder, rung 1: a reply delivered to ${replyTo} must route by rung 1 — ` +
        "EM-8's whole point is that this address IS the plus-addressed envelope recipient rung 1 " +
        "already reads",
    ).toBe(1)
    expect(
      matchesSubmission(inbound.routed_submission_id, sub),
      `the reply must route to the EXACT submission (${JSON.stringify(sub)}) EM-8's Reply-To was ` +
        `computed for, not some other one. Got routed_submission_id=${inbound.routed_submission_id}`,
    ).toBe(true)

    // The full round trip, one layer further: rung 1 also appends the
    // message to that submission's thread (EM-5's own write, already sealed
    // by `ms-5/165`) — checked here only as confirmation that the reply
    // genuinely reached the submission EM-8's Reply-To named, not as a fresh
    // assertion of EM-5's own behaviour.
    const appended = messagesFor(sub.reference)
    expect(
      appended.length,
      `a message row on ${sub.reference}'s own thread, confirming the round trip actually landed`,
    ).toBeGreaterThan(0)
  })

  test("an outbox row with no submission reference to bear sends with a Reply-To that is present-and-plausible or absent, never a malformed one", async ({
    request,
  }) => {
    // Contract § "Reply-To on outbound mail", bullet 3: "A row with no
    // submission reference (should not occur) sends with the plain
    // configured address rather than a malformed one — absent beats broken,
    // the same rule `replyTo` and `html` already follow at that seam."
    //
    // TODO(test-author): neither issue #168 nor the contract names the exact
    // fallback mechanism (a distinct config var, a stripped form of the
    // templated `REPLY_TO`, or something else), so this test does not assert
    // an exact expected string — see this file's header. What IS checkable,
    // and asserted below, is the negative half the contract itself states in
    // as many words: never malformed. "Absent" (no Reply-To header at all)
    // is the pre-existing convention `OutboundEmail.replyTo`'s own doc
    // already establishes ("a provider that receives no value must send no
    // Reply-To header rather than inventing one"), so this test accepts
    // either outcome.
    //
    // The scenario: an `intake-reply` outbox row whose `submission_id` is an
    // `inbound_emails.id` with no `routed_submission_id` at all — the same
    // shape EM-4's own rung-6 stranger case produces (already sealed by
    // `ms-5/164-em4-stranger-lead.spec.ts`; not re-exercised here). There is
    // no submission for a reference to be derived from, by construction.
    const strangerInboundId = insertStrangerInboundEmail()
    const to = `${unique("stranger-recipient")}@example.test`
    const row = insertOutboxRow({
      submissionId: strangerInboundId,
      toEmail: to,
      emailType: "intake-reply",
      approvalState: "approved", // bypass #166's own approve UI — not this slice's concern
    })

    const sent = await drainToTerminal(request, row)
    expect(sent.status, "a row addressed to a recipient with no `mailfail` substring must be sent").toBe("sent")

    const recorded = await recordedFor(request, to)
    expect(recorded, `exactly one recorded payload for ${to}`).toHaveLength(1)
    const replyTo = recorded[0].replyTo

    if (replyTo === undefined || replyTo === null || replyTo === "") {
      // Absent — the pre-existing "absent beats broken" convention. Nothing
      // further to check.
      return
    }

    expect(
      replyTo,
      `a Reply-To WAS recorded (${replyTo}) for a row with no submission to derive a reference ` +
        "from — contract: \"rather than a malformed one\". Must not carry a plus-address at all: " +
        "there is no reference for one to name.",
    ).not.toMatch(/\+[^@]*@/)
    expect(replyTo, "must not leak the literal, unresolved template token").not.toContain("{submission_reference}")
    expect(replyTo, "must not be the string 'undefined'").not.toBe("undefined")
    expect(replyTo, "must not be the string 'null'").not.toBe("null")
    expect(replyTo, "must not contain 'undefined'").not.toContain("undefined")
    expect(replyTo, "must not contain 'null'").not.toContain("null")
    expect(replyTo, "must not contain 'NaN'").not.toContain("NaN")
    expect(
      replyTo,
      `a present Reply-To must at least be shaped like an address (got ${JSON.stringify(replyTo)})`,
    ).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
  })
})
