import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test"

/**
 * ms-5 sealed acceptance slice — issue #169
 * "[portal] EM-9: rate-limit inbound drafts, and say out loud that
 *  attachments are dropped"
 *
 * Written from `tests/acceptance/ms-5/contract.md` (§ "Rate limiting (issue
 * #169...)", § "Attachments (issue #169...)", § "The inbound test door" (the
 * MIME-multipart requirement for `attachment_count`), § "/replies — pinned
 * data-testid hooks" (`reply-attachments-dropped`), § "/replies/:id — pinned
 * data-testid hooks", § "Schema — inbound_emails" (`attachment_count`)) and
 * issue #169's own text, without sight of any implementation.
 *
 * ── WHAT #169 OWNS, AND WHAT THIS SLICE THEREFORE COVERS ────────────────────
 *
 * #169's own Scope, quoted: "The abuse controls a mailbox needs and a form
 * already has." Two independent halves:
 *
 *   1. **Rate limiting.** "Cap drafts created, per sender and in total,
 *      reusing the shape `src/rateLimit.ts` already has." Contract pins the
 *      numbers (still its own invention, confirmed nowhere in issue text):
 *      more than 5 drafts from one sender, or more than 20 total, within any
 *      5-second window, and the overflow message gets
 *      `disposition = 'rate_limited'` — "still recorded... it just does not
 *      earn a reply... should not erase the evidence of itself." No outbox
 *      row, no leads row, no messages row for a rate-limited message.
 *   2. **Attachments.** "Dropped, and the reply says so." `attachment_count`
 *      records how many MIME attachment parts a message carried; the payload
 *      itself is never stored; `reply-attachments-dropped` renders the count
 *      on both `/replies` and `/replies/:id`; the drafted reply's own body
 *      says an attachment was received and not saved.
 *
 * ── WHY THIS SLICE NEVER SEEDS ANYTHING DIRECTLY ────────────────────────────
 *
 * Same posture `ms-5/164-em4-stranger-lead.spec.ts` takes for its own
 * write path: every row this file inspects is produced through the real
 * `POST /__email` door (#161, already sealed and landed) and read back
 * read-only. Rendering assertions go through the real `/replies*` screens
 * (#166, already sealed and landed) with a real operator identity, never a
 * seeded row.
 *
 * ── WHY THIS SLICE SLEEPS BETWEEN BURSTS ─────────────────────────────────────
 *
 * The rate limit is a *sliding* 5-second window shared across every sender
 * (contract: "reusing the shape `src/rateLimit.ts` already has... a sliding
 * window (`WINDOW_MS = 5_000`) recomputed per request"). `playwright.
 * acceptance.config.ts` runs this whole suite with `workers: 1` and
 * `fullyParallel: false`, so tests never race each other, but a burst of
 * requests from an EARLIER test in this same file can still be inside the
 * window a LATER test's own count depends on. Every test that sends a burst
 * therefore starts by sleeping past `WINDOW_MS` first, so its own count
 * starts from whatever the window already looks like from unrelated traffic
 * — never assumed to be zero, since other ms-5 slices may also have driven
 * `POST /__email` earlier in the same run — but stable and NOT still
 * climbing from a burst this same file just sent.
 *
 * ── NOT COVERED HERE, AND WHY ────────────────────────────────────────────────
 *  - **The router, the draft template's own copy/idempotency, `/replies`'s
 *    other hooks and actions, promotion, `Reply-To`.** All other, already
 *    sealed issues (#161-#168) — this slice only reaches far enough into
 *    those paths to prove a normal message still drafts (the necessary
 *    contrast for "past the cap gets none").
 *  - **The exact rate-limit numbers matching `src/rateLimit.ts`'s own
 *    `start_attempts` cap for `/start`.** Contract is explicit these are
 *    independently invented thresholds for this table, "reusing the shape,"
 *    not the same numeric values `/start`'s own #32 rate limit uses.
 *  - **Where a rate-limited row becomes visible in the product, if anywhere.**
 *    Contract's own Notes: "not pinned... if an operator needs to see
 *    rate-limited/suppressed traffic, that is a future issue." This slice
 *    only reads the row back directly (the same read-only D1 instrument
 *    `ms-5/161` established), never through a screen no issue text asked for.
 *  - **The attachment payload's own storage (or lack of it).** Contract:
 *    "not itself black-box observable beyond its effect on
 *    `attachment_count`." This slice asserts the count and the drafted
 *    body's copy, never that the bytes are (or are not) retrievable anywhere
 *    — there is no route this milestone pins that could answer that.
 *  - **The exact wording of the "attachments not received" sentence, or
 *    whether it names the count as a digit.** Contract's own posture:
 *    "exact wording not pinned... a test MAY assert the body contains the
 *    count as a base-10 integer" — phrased as optional, and mock 04's own
 *    illustrative body ("the attachment you sent doesn't come through this
 *    mailbox, so I don't have it yet") does not itself contain a digit.
 *    TODO(test-author): this slice therefore does NOT require a digit in
 *    `reply-body-field`'s text, only that it mentions an attachment was not
 *    received and does not affirmatively claim one was kept/saved/available.
 *    The base-10-integer requirement IS enforced, hard, on
 *    `reply-attachments-dropped` instead — that one is unambiguously pinned
 *    ("must contain a base-10 integer matching the count") and mock 01/04
 *    both render it that way ("📎 1 attachment — not saved").
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and contract § "Synthetic data", every
 * address, name and message body below is invented on the reserved
 * `example.test` TLD — never the real `intake@heurontech.com` /
 * `mail.heurontech.com` domains this milestone actually wires up.
 */

test.describe.configure({ timeout: 180_000 })

// ── the repository, as a D1 read-only surface (mirrors every prior ms-5 slice) ─

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
      `${process.cwd()} — this slice reads the migrated local D1, and only through it`,
  )
}

interface D1Query {
  ok: boolean
  rows: Record<string, unknown>[]
  error: string | null
}

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

function countWhere(table: string, column: string, value: string): number {
  const q = d1(`SELECT COUNT(*) as n FROM ${table} WHERE ${column} = '${escapeSql(value)}'`)
  if (!q.ok) return -1
  return Number((q.rows[0] as { n: unknown } | undefined)?.n ?? -1)
}

let counter = 0
/** A unique, synthetic local-part — every message in this slice owns its own address. */
function unique(label: string): string {
  counter += 1
  return `ms5-169-${label}-${Date.now()}-${counter}`
}

// ── the inbound test door (mirrors every prior ms-5 slice) ──────────────────

const EMAIL_DOOR = "/__email"

const DOOR_UNAVAILABLE =
  `ms-5 issue #169 cannot be observed at all: \`POST ${EMAIL_DOOR}\` did not answer with the ` +
  "pinned `{id, disposition}` JSON shape. This door is #161's own, already sealed and landed — a " +
  "failure here means the acceptance environment itself is broken, not a #169 defect."

interface RawMessageOpts {
  from: string
  subject: string
  messageId: string | null
  body: string
}

function buildRawMessage(opts: RawMessageOpts): string {
  const headers: string[] = []
  headers.push(`From: ${opts.from}`)
  headers.push(`To: intake@mail.example.test`) // informational only — envelope ?to= is what counts
  headers.push(`Subject: ${opts.subject}`)
  if (opts.messageId) headers.push(`Message-ID: ${opts.messageId}`)
  headers.push(`Date: ${new Date().toUTCString()}`)
  headers.push("MIME-Version: 1.0")
  headers.push("Content-Type: text/plain; charset=utf-8")
  return headers.join("\r\n") + "\r\n\r\n" + opts.body
}

/**
 * A multipart/mixed RFC 822 blob carrying one attachment part — the shape
 * contract § "Attachments" requires to exercise `attachment_count` at all
 * ("a synthetic fixture that wants `attachment_count > 0` must include a real
 * MIME multipart with attachment parts in the blob it posts"). The attached
 * bytes are invented ASCII, base64-encoded, never a real file.
 */
function buildRawMessageWithAttachment(opts: RawMessageOpts): string {
  const boundary = `ms5-169-boundary-${unique("mime")}`
  const headers = [
    `From: ${opts.from}`,
    `To: intake@mail.example.test`,
    `Subject: ${opts.subject}`,
    opts.messageId ? `Message-ID: ${opts.messageId}` : null,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter((line): line is string => line !== null)

  const textPart = [`--${boundary}`, `Content-Type: text/plain; charset=utf-8`, "", opts.body].join("\r\n")

  const attachmentBody = Buffer.from(
    "synthetic screenshot bytes, invented for ms-5 #169 acceptance — never a real customer file",
    "utf8",
  ).toString("base64")

  const attachmentPart = [
    `--${boundary}`,
    `Content-Type: image/png; name="layout-issue.png"`,
    `Content-Disposition: attachment; filename="layout-issue.png"`,
    `Content-Transfer-Encoding: base64`,
    "",
    attachmentBody,
  ].join("\r\n")

  return headers.join("\r\n") + "\r\n\r\n" + textPart + "\r\n" + attachmentPart + "\r\n" + `--${boundary}--\r\n`
}

interface DoorResponse {
  id?: unknown
  disposition?: unknown
}

interface DoorResult {
  status: number
  body: DoorResponse | null
  text: string
}

async function postEmail(
  request: APIRequestContext,
  envelopeTo: string,
  envelopeFrom: string,
  raw: string,
): Promise<DoorResult> {
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
  return { status: res.status(), body, text }
}

/** Drive `POST /__email` and assert it answered the pinned `{id, disposition}` shape. */
async function deliver(
  request: APIRequestContext,
  from: string,
  raw: string,
): Promise<{ id: string; disposition: string }> {
  const to = `${unique("recipient")}-to@example.test`
  const result = await postEmail(request, to, from, raw)
  expect(result.status, `${DOOR_UNAVAILABLE} (got HTTP ${result.status}, body: ${result.text})`).toBe(200)
  expect(result.body, `${DOOR_UNAVAILABLE} (body was not JSON: ${result.text})`).not.toBeNull()
  const body = result.body as DoorResponse
  expect(typeof body.id, "the pinned response carries a non-empty id").toBe("string")
  expect(typeof body.disposition, "the pinned response carries a disposition string").toBe("string")
  return { id: body.id as string, disposition: body.disposition as string }
}

// ── reading rows back, read-only ─────────────────────────────────────────────

interface InboundRow {
  id: string
  from_email: string | null
  disposition: string | null
  routed_kind: string | null
  outbox_id: string | null
  attachment_count: number
}

function inboundRowById(id: string): InboundRow | null {
  const q = d1(`SELECT * FROM inbound_emails WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as InboundRow
}

interface OutboxRow {
  id: string
  to_email: string
  subject: string
  body: string
  approval_state: string
}

function outboxRowById(id: string): OutboxRow | null {
  const q = d1(`SELECT * FROM outbox WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as OutboxRow
}

// ── the rate-limit window (mirrors contract § "Rate limiting", quoting
// `src/rateLimit.ts`'s own shape verbatim) ───────────────────────────────────

/** Contract § "Rate limiting": "That module's own shape is a sliding window (`WINDOW_MS = 5_000`)". */
const WINDOW_MS = 5_000
/** Comfortably past `WINDOW_MS` so an earlier test's own burst has fully aged out of the window. */
const WINDOW_CLEAR_MS = WINDOW_MS + 1_500

/** Contract § "Rate limiting": "more than 5 drafts within any 5-second window" — the 6th is the first overflow. */
const PER_SENDER_CAP = 5
/** Contract § "Rate limiting": "more than 20 drafts across all senders within any 5-second window". */
const TOTAL_CAP = 20

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ── operator identity (mirrors every prior ms-5 slice that renders a screen) ─

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"
const OPERATOR_EMAIL = process.env.COORD_PORTAL_OPERATOR_EMAIL ?? "ops@example.test"

function asOperator(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: OPERATOR_EMAIL } })
}

/** Mirrors `ms-5/164`/`ms-5/166`'s own `replyPathBySender` — finds a pending draft's own detail path. */
async function replyPathBySender(operator: Page, email: string): Promise<string> {
  await operator.goto("/replies")
  const row = operator.getByTestId("reply-row").filter({ hasText: email })
  await expect(row, `exactly one /replies row for ${email}`).toHaveCount(1)
  const href = await row.getByTestId("review-reply").getAttribute("href")
  expect(href, "review-reply links to the reply's own detail screen").toMatch(/^\/replies\/[^/]+$/)
  return href!
}

// Phrases that would claim the attachment is actually in hand — contract:
// "does not claim the attachment was kept, saved, or is retrievable." A
// well-written draft (mock 04's own illustrative body: "I don't have it yet")
// avoids these phrasings entirely rather than negating them, so this is a
// deliberately narrow forbidden set — matching only an affirmative claim of
// possession, never a legitimate "not saved"/"wasn't kept" negation.
const FALSE_POSSESSION_CLAIM =
  /\b(we (have |'ve )?saved|has been saved|is saved|we('ve| have)? kept|is available (for|to) download|can (be )?download|is retrievable|we (now )?have (your |the )?attachment|got your attachment)\b/i

// ═══════════════════════════════════════════════════════════════════════════

test.describe("ms-5 issue 169 EM-9: rate-limit inbound drafts, and say out loud that attachments are dropped", () => {
  // ── the positive control: an ordinary message, under every cap ──────────

  test("a sender under the cap gets a recorded inbound row and a new draft", async ({ request }) => {
    await sleep(WINDOW_CLEAR_MS)

    const from = `${unique("under-cap")}@example.test`
    const raw = buildRawMessage({
      from,
      subject: "A single, ordinary message",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "Nothing unusual here — one message, one sender, well under any cap.",
    })

    const delivered = await deliver(request, from, raw)
    expect(delivered.disposition, "issue #169 acceptance: \"a sender under it gets both\"").toBe("received")

    const row = inboundRowById(delivered.id)
    expect(row, `no inbound_emails row was found for id ${JSON.stringify(delivered.id)}`).not.toBeNull()
    expect((row as InboundRow).disposition).toBe("received")
    expect(
      (row as InboundRow).outbox_id,
      "issue #169 acceptance: \"a sender under it gets both\" — a recorded row AND a new draft",
    ).not.toBeNull()

    const outboxRow = outboxRowById((row as InboundRow).outbox_id as string)
    expect(outboxRow, "the outbox_id recorded on the inbound row must resolve to a real outbox row").not.toBeNull()
  })

  // ── per-sender cap ─────────────────────────────────────────────────────

  test("a sender past the per-sender cap gets a recorded inbound row and no new draft, while their earlier messages in the same window still draft", async ({
    request,
  }) => {
    await sleep(WINDOW_CLEAR_MS)

    const from = `${unique("sender-cap")}@example.test`
    const burstSize = PER_SENDER_CAP + 2 // two messages should overflow (6th, 7th)

    const outboxBefore = countWhere("outbox", "to_email", from)

    const results: { id: string; disposition: string }[] = []
    for (let i = 0; i < burstSize; i++) {
      const raw = buildRawMessage({
        from,
        subject: `Per-sender burst message #${i + 1}`,
        messageId: `<${unique(`sender-cap-${i}`)}@example.test>`,
        body: `Burst message #${i + 1} of ${burstSize} from the same sender, sent within the same window.`,
      })
      // eslint-disable-next-line no-await-in-loop -- ordering across the burst is the whole point
      const delivered = await deliver(request, from, raw)
      results.push(delivered)
    }

    for (let i = 0; i < PER_SENDER_CAP; i++) {
      expect(
        results[i].disposition,
        `contract § "Rate limiting": message #${i + 1} from this sender is within the per-sender cap of ` +
          `${PER_SENDER_CAP} and must be accepted`,
      ).toBe("received")
    }
    for (let i = PER_SENDER_CAP; i < burstSize; i++) {
      expect(
        results[i].disposition,
        `contract § "Rate limiting": message #${i + 1} from this sender exceeds the per-sender cap of ` +
          `${PER_SENDER_CAP} within the window and must be "rate_limited"`,
      ).toBe("rate_limited")
    }

    for (let i = PER_SENDER_CAP; i < burstSize; i++) {
      const row = inboundRowById(results[i].id)
      expect(
        row,
        `issue #169: a rate-limited message is "still recorded... should not erase the evidence of ` +
          `itself" — no row found for id ${JSON.stringify(results[i].id)}`,
      ).not.toBeNull()
      expect((row as InboundRow).disposition).toBe("rate_limited")
      expect((row as InboundRow).outbox_id, "issue #169: a rate-limited message \"does not earn a reply\"").toBeNull()
    }

    // The two overflow messages must not have added any new drafts beyond
    // what the first five (accepted) messages already produced.
    const outboxAfter = countWhere("outbox", "to_email", from)
    expect(
      outboxAfter - outboxBefore,
      `exactly ${PER_SENDER_CAP} drafts should exist for ${from} — the ${burstSize - PER_SENDER_CAP} ` +
        "rate-limited overflow message(s) must add none",
    ).toBe(PER_SENDER_CAP)
  })

  // ── total cap, across senders ──────────────────────────────────────────

  test("more than 20 drafts across all senders in the same window rate-limits the overflow, regardless of sender", async ({
    request,
  }) => {
    await sleep(WINDOW_CLEAR_MS)

    const burstSize = TOTAL_CAP + 1 // the 21st message, from yet another sender, should overflow
    const senders: string[] = []
    for (let i = 0; i < burstSize; i++) senders.push(`${unique(`total-cap-${i}`)}@example.test`)

    const results: { id: string; disposition: string }[] = []
    for (let i = 0; i < burstSize; i++) {
      const from = senders[i]
      const raw = buildRawMessage({
        from,
        subject: `Total-cap burst message #${i + 1}`,
        messageId: `<${unique(`total-cap-msg-${i}`)}@example.test>`,
        body: `Message #${i + 1} of ${burstSize}, each from its own, never-before-seen sender.`,
      })
      // eslint-disable-next-line no-await-in-loop -- ordering across the burst is the whole point
      const delivered = await deliver(request, from, raw)
      results.push(delivered)
    }

    for (let i = 0; i < TOTAL_CAP; i++) {
      expect(
        results[i].disposition,
        `contract § "Rate limiting": message #${i + 1} is within the total cap of ${TOTAL_CAP} across all ` +
          "senders and must be accepted",
      ).toBe("received")
    }
    for (let i = TOTAL_CAP; i < burstSize; i++) {
      expect(
        results[i].disposition,
        `contract § "Rate limiting": message #${i + 1} exceeds the total cap of ${TOTAL_CAP} across all ` +
          'senders within the window and must be "rate_limited" — "regardless of sender"',
      ).toBe("rate_limited")
    }

    for (let i = TOTAL_CAP; i < burstSize; i++) {
      const row = inboundRowById(results[i].id)
      expect(row, "a total-cap-overflow message is still recorded, never dropped silently").not.toBeNull()
      expect((row as InboundRow).disposition).toBe("rate_limited")
      expect((row as InboundRow).outbox_id, "a total-cap-overflow message earns no draft").toBeNull()
      expect(countWhere("outbox", "to_email", senders[i]), "no draft exists for the overflow sender").toBe(0)
    }
  })

  // ── attachments: dropped, counted, and disclosed ─────────────────────────

  test("a message with an attachment records the count, drops the payload, and its draft's rendered body says the attachment was not received", async ({
    request,
  }) => {
    await sleep(WINDOW_CLEAR_MS) // stay clear of the previous test's own 21-message burst

    const from = `${unique("attachment")}@example.test`
    const raw = buildRawMessageWithAttachment({
      from,
      subject: "One more thing while I have you",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "I attached a screenshot of the issue — let me know if you need anything else.",
    })

    const delivered = await deliver(request, from, raw)
    expect(delivered.disposition, "an attachment alone must not change disposition").toBe("received")

    const row = inboundRowById(delivered.id) as InboundRow
    expect(row, `no inbound_emails row was found for id ${JSON.stringify(delivered.id)}`).not.toBeNull()
    expect(
      row.attachment_count,
      "contract § \"Attachments\": attachment_count is set from the MIME parts postal-mime reports as " +
        "attachments — this message carried exactly one",
    ).toBe(1)
    expect(row.outbox_id, "an attachment does not prevent a draft from being created").not.toBeNull()

    const outboxRow = outboxRowById(row.outbox_id as string) as OutboxRow
    const draftBody = outboxRow.body

    expect(
      /attach/i.test(draftBody),
      `issue #169 acceptance: "its draft's rendered body says attachments were not received" — the ` +
        `drafted body should mention the attachment. Got: ${JSON.stringify(draftBody)}`,
    ).toBe(true)
    expect(
      FALSE_POSSESSION_CLAIM.test(draftBody),
      'contract § "Attachments": the drafted body "does not claim the attachment was kept, saved, or is ' +
        `retrievable". Got: ${JSON.stringify(draftBody)}`,
    ).toBe(false)

    // Never quotes the sender's own words back to them — issue #164's own
    // rule, unaffected by this being an attachment-bearing message.
    expect(
      draftBody.includes("I attached a screenshot of the issue"),
      "the drafted body must never quote the sender's own message text back to them",
    ).toBe(false)
  })

  // ── reply-attachments-dropped: presence, absence, and the pinned integer ──

  test("reply-attachments-dropped renders the count on /replies and /replies/:id, and is absent when there is none", async ({
    request,
    browser,
    baseURL,
  }) => {
    await sleep(WINDOW_CLEAR_MS)

    // One message with no attachment, one with two — read back through the
    // real /replies*, screens #166 already sealed, never a seeded row.
    const bareFrom = `${unique("no-attachment")}@example.test`
    const bareRaw = buildRawMessage({
      from: bareFrom,
      subject: "No attachment here",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "Just text, nothing attached.",
    })
    const bareDelivered = await deliver(request, bareFrom, bareRaw)
    expect(bareDelivered.disposition).toBe("received")
    expect((inboundRowById(bareDelivered.id) as InboundRow).attachment_count).toBe(0)

    const attachedFrom = `${unique("with-attachment")}@example.test`
    const attachedRaw = buildRawMessageWithAttachment({
      from: attachedFrom,
      subject: "Screenshot attached",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "See attached.",
    })
    const attachedDelivered = await deliver(request, attachedFrom, attachedRaw)
    expect(attachedDelivered.disposition).toBe("received")
    const attachedRow = inboundRowById(attachedDelivered.id) as InboundRow
    expect(attachedRow.attachment_count).toBeGreaterThan(0)
    const expectedCount = String(attachedRow.attachment_count)

    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    await operator.goto("/replies")

    const bareRow = operator.getByTestId("reply-row").filter({ hasText: bareFrom })
    await expect(bareRow, `exactly one /replies row for ${bareFrom}`).toHaveCount(1)
    await expect(
      bareRow.getByTestId("reply-attachments-dropped"),
      'contract: "Absent when the count is zero — same present-iff convention"',
    ).toHaveCount(0)

    const attachedListRow = operator.getByTestId("reply-row").filter({ hasText: attachedFrom })
    await expect(attachedListRow, `exactly one /replies row for ${attachedFrom}`).toHaveCount(1)
    const listBadge = attachedListRow.getByTestId("reply-attachments-dropped")
    await expect(listBadge, 'contract: present iff attachment_count > 0').toHaveCount(1)
    const listBadgeText = await listBadge.innerText()
    expect(
      new RegExp(`\\b${expectedCount}\\b`).test(listBadgeText),
      `contract: "must contain a base-10 integer matching the count" (${expectedCount}). Got: ` +
        `${JSON.stringify(listBadgeText)}`,
    ).toBe(true)

    const path = await replyPathBySender(operator, attachedFrom)
    await operator.goto(path)
    const detailBadge = operator.getByTestId("reply-attachments-dropped")
    await expect(detailBadge, "identical hooks and presence rules to the list row").toHaveCount(1)
    const detailBadgeText = await detailBadge.innerText()
    expect(new RegExp(`\\b${expectedCount}\\b`).test(detailBadgeText)).toBe(true)

    await expect(
      operator.getByTestId("reply-detail"),
      "sanity: this is genuinely the attached-message row, not a different one"
    ).toContainText(attachedFrom)

    // And the bare (no-attachment) row's own detail screen has no such hook either.
    const barePath = await replyPathBySender(operator, bareFrom)
    await operator.goto(barePath)
    await expect(operator.getByTestId("reply-attachments-dropped")).toHaveCount(0)

    await operatorCtx.close()
  })
})
