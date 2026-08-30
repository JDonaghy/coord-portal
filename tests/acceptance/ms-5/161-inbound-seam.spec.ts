import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect, test, type APIRequestContext } from "@playwright/test"

/**
 * ms-5 sealed acceptance slice — issue #161
 * "[portal] EM-1: inbound seam — email() handler, inbound_emails, loop
 *  suppression, and the POST /__email test door"
 *
 * Written from `tests/acceptance/ms-5/contract.md` (§ "Route surface", § "The
 * inbound test door", § "Schema — inbound_emails", § "The router ladder" (only
 * the DMARC-gating vocabulary, `pass`/`fail`/`none`, which #161 itself owns),
 * § "Ownership") and issue #161's own text, without sight of any
 * implementation.
 *
 * ── WHAT #161 OWNS, AND WHAT THIS SLICE THEREFORE COVERS ────────────────────
 *
 * #161 is the milestone's own "keystone": "prove one real message lands as one
 * row, before anything is built on top of it." Its own Scope is explicit that
 * it "routes nothing and replies to nothing" — no `/replies` screen (#166), no
 * router (#163), no draft template (#164), no promotion (#167). Everything
 * this slice asserts is therefore one of:
 *
 *   1. `migrations/0020_inbound_emails.sql` landed, with the shape the
 *      contract's schema table pins (base columns #161 commits to by name,
 *      plus the routing columns later issues will fill but #161's own
 *      migration must already carry, nullable, for them to fill).
 *   2. `POST /__email` accepts a raw RFC 822 blob plus out-of-band envelope
 *      `to`/`from`, and drives the same `email()` handler Cloudflare Email
 *      Routing would.
 *   3. A plain message produces exactly one row, with the parsed fields, and
 *      —because #161 routes nothing— no `leads`/`outbox` row and every
 *      routing column left `NULL`.
 *   4. The DMARC verdict is recorded in `auth_result` as `pass` / `fail` /
 *      `none` (contract § "`/replies` — pinned `data-testid` hooks",
 *      `reply-auth-result`, is where this vocabulary is actually pinned
 *      three-ways, but the value is #161's own parse of
 *      `Authentication-Results` and belongs to this slice, not #166's).
 *   5. Loop suppression — all five of #161's own independently-sufficient
 *      conditions — writes a `suppressed` row with no draft and no routing.
 *   6. `UNIQUE (message_id, to_email)`: a redelivery produces no second row.
 *   7. Size caps: an oversized `body_text` is stored truncated and flagged,
 *      never dropped silently.
 *
 * ── WHY THIS SLICE READS THE LOCAL D1 DIRECTLY ───────────────────────────────
 *
 * `POST /__email`'s own pinned response is `{id, disposition}` only — there is
 * no `GET` route anywhere in this milestone's Route surface that reads a raw
 * `inbound_emails` row back (that is `/replies`/`/replies/:id`, #166's own
 * screen, gated on a row having been *routed*, which #161 never does). Reading
 * the migrated local D1 directly with `wrangler d1 execute --local` is the
 * same instrument `ms-4/128-clients-schema.spec.ts` already established for
 * exactly this situation — a real, externally-checkable artifact with no HTTP
 * read surface of its own — and it is READ-ONLY here for the same reason:
 * every row this slice inspects was created through the real `POST /__email`
 * surface, never inserted directly, so a sibling slice sharing this database
 * is never contaminated by this one's setup.
 *
 * ── NOT COVERED HERE, AND WHY ────────────────────────────────────────────────
 *
 *  - **`POST /__email`'s production/non-fake gating.** Contract: gated exactly
 *    like `GET /__outbound`, `env.MAIL_PROVIDER === "fake"` otherwise 404. Every
 *    acceptance run boots via `serve:acceptance`, which unconditionally passes
 *    `--var MAIL_PROVIDER:fake` — the same reason `ms-3/51-mail-provider.spec.ts`
 *    cannot reach the real Resend path from this suite. TODO(test-author): the
 *    negative branch is unreachable from this environment by construction.
 *  - **The router (#163), `/replies` (#166), the draft template (#164),
 *    promotion (#167), `Reply-To` (#168), rate limiting and attachments
 *    (#169).** Explicitly out of scope for #161's own issue text. Their own
 *    slices, dispatched separately, own that surface — this slice only proves
 *    #161's migration already carries the nullable columns they will fill.
 *  - **The exact reason string recorded for a suppressed row.** Scope item 4
 *    says "record the reason", but the contract's schema section does not name
 *    a column for it (unlike `routed_reason`, which is explicitly named and
 *    owned by #163). TODO(test-author): no black-box surface this contract
 *    pins can read a suppression reason back at #161's stage, so this slice
 *    asserts only the pinned, checkable half — `disposition = 'suppressed'`.
 *  - **The exact content-type `POST /__email` requires.** Contract: "the exact
 *    content-type is this contract's own invention, unconfirmed by any issue
 *    text." This slice sends `message/rfc822`, the contract's own first
 *    example; a door that instead requires `text/plain` (the contract's other
 *    named option) has not necessarily violated the contract, only this
 *    slice's particular choice of instrument.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and contract § "Synthetic data", every
 * address, name and message body below is invented on the reserved
 * `example.test` TLD — never the real `intake@heurontech.com` /
 * `mail.heurontech.com` domains this milestone wires up in production.
 */

test.describe.configure({ timeout: 90_000 })

// ── the repository, as a config + schema surface (mirrors ms-3/51, ms-4/128) ─

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
      `${process.cwd()} — this slice reads both the migrated local D1 and the committed Worker ` +
      "configuration",
  )
}

interface D1Query {
  ok: boolean
  rows: Record<string, unknown>[]
  error: string | null
}

/**
 * Ask the migrated local D1 a read-only question. Identical mechanism to
 * `ms-4/128-clients-schema.spec.ts`'s own `d1()` — see that file's comment for
 * why this is legitimate black-box surface rather than a peek at the SQL
 * source: it reads the *applied* schema/rows, the same database the Worker
 * under test serves from, never `migrations/*.sql` itself.
 */
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

interface Column {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

function columnsOf(table: string): Column[] | null {
  const q = d1(`PRAGMA table_info(${table})`)
  if (!q.ok) return null
  if (q.rows.length === 0) return null
  return q.rows as unknown as Column[]
}

function column(cols: Column[], name: string): Column | undefined {
  return cols.find((c) => c.name === name)
}

interface IndexEntry {
  name: string
  unique: number
  origin: string
}

function indexesOf(table: string): IndexEntry[] {
  const q = d1(`PRAGMA index_list(${table})`)
  return q.ok ? (q.rows as unknown as IndexEntry[]) : []
}

function indexColumns(index: string): string[] {
  const q = d1(`PRAGMA index_info("${index}")`)
  return q.ok ? q.rows.map((r) => String(r.name)) : []
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''")
}

function countWhere(table: string, column: string, value: string): number {
  const q = d1(`SELECT COUNT(*) as n FROM ${table} WHERE ${column} = '${escapeSql(value)}'`)
  if (!q.ok) return -1
  return Number((q.rows[0] as { n: unknown } | undefined)?.n ?? -1)
}

/**
 * The schema version at the head of `migrations/` before ms-5 —
 * `0019_client_merge.sql`. #161 is a migration (`0020_inbound_emails.sql`), so
 * whatever it is numbered, `GET /api/health` must report a version past this.
 */
const SCHEMA_HEAD_BEFORE_MS5 = 19

/**
 * Where the acceptance environment declares a var — mirrors
 * `ms-3/51-mail-provider.spec.ts`'s `declaredEmailFrom`, generalised to any
 * `--var NAME:value` on `serve:acceptance` (package.json) falling back to
 * `wrangler.toml`'s `[vars]` table. Used only to build a synthetic sender that
 * is guaranteed to match whatever this portal's own `EMAIL_FROM`/`REPLY_TO`
 * actually is in the running acceptance Worker, per contract § "Loop
 * suppression": "the sender address is one of this portal's own sending
 * domains (EMAIL_FROM, REPLY_TO)".
 */
function declaredVar(name: string): string | null {
  const root = repoRoot()
  const pkgPath = join(root, "package.json")
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> }
    const serve = pkg.scripts?.["serve:acceptance"] ?? ""
    const flag = new RegExp(`--var\\s+${name}[:=](\"[^\"]*\"|'[^']*'|[^\\s]+)`).exec(serve)
    if (flag) return flag[1].replace(/^["']|["']$/g, "")
  }

  const tomlPath = join(root, "wrangler.toml")
  if (existsSync(tomlPath)) {
    const toml = readFileSync(tomlPath, "utf8")
    const assigned = new RegExp(`^\\s*${name}\\s*=\\s*["']([^"']*)["']`, "m").exec(toml)
    if (assigned) return assigned[1]
  }
  return null
}

/** Pulls `addr` out of `Display Name <addr>`, or returns the input verbatim. */
function extractAddress(raw: string): string {
  const angled = /<([^>]+)>/.exec(raw)
  return angled ? angled[1] : raw.trim()
}

// ── the inbound test door ────────────────────────────────────────────────────

/** Contract § "Route surface (pinned)": `POST /__email`. */
const EMAIL_DOOR = "/__email"

/** Contract § "Route surface (pinned)": `GET /api/health`, reused as a liveness/schema probe. */
const HEALTH = "/api/health"

const DOOR_UNAVAILABLE =
  `ms-5 issue #161 cannot be observed at all: \`POST ${EMAIL_DOOR}\` did not answer with the ` +
  "pinned `{id, disposition}` JSON shape. Contract § \"The inbound test door\": gated on " +
  '`env.MAIL_PROVIDER === "fake"`, which `npm run serve:acceptance` always sets, so a 404 here ' +
  "means the door itself does not exist yet, not a gating decision."

let counter = 0
/** A unique, synthetic local-part — every test in this slice owns its own address. */
function unique(label: string): string {
  counter += 1
  return `ms5-161-${label}-${Date.now()}-${counter}`
}

interface RawMessageOpts {
  from: string
  to?: string
  subject: string
  messageId: string | null
  body: string
  extraHeaders?: Record<string, string>
}

/**
 * A minimal, valid RFC 822 blob — headers, a blank line, then the body —
 * exactly the shape contract § "The inbound test door" pins `postal-mime`
 * parses in production. `To:` here is the MIME header only, deliberately
 * distinct from the envelope recipient every test passes separately via
 * `?to=` — contract is explicit these must NOT be conflated ("this carries
 * the plus-address token EM-3 rung 1 needs").
 */
function buildRawMessage(opts: RawMessageOpts): string {
  const headers: string[] = []
  headers.push(`From: ${opts.from}`)
  if (opts.to) headers.push(`To: ${opts.to}`)
  headers.push(`Subject: ${opts.subject}`)
  if (opts.messageId) headers.push(`Message-ID: ${opts.messageId}`)
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

interface DoorResult {
  status: number
  body: DoorResponse | null
  text: string
}

/**
 * Drive `POST /__email`. `envelopeTo`/`envelopeFrom` are this slice's own
 * invented mechanism for the envelope recipient/sender — contract § "The
 * inbound test door" pins that the door must accept them "out-of-band from
 * the blob" and names `?to=`/`?from=` as its own concrete (but not
 * exclusive) choice.
 */
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

// ── reading the row back, read-only ──────────────────────────────────────────

interface InboundRow {
  id: string
  message_id: string | null
  from_email: string | null
  from_name: string | null
  to_email: string | null
  subject: string | null
  body_text: string | null
  received_at: string | null
  auth_result: string | null
  disposition: string | null
  routed_kind: string | null
  routed_rung: number | null
  routed_reason: string | null
  routed_runner_up: string | null
  routed_lead_id: string | null
  routed_project_id: string | null
  routed_submission_id: string | null
  outbox_id: string | null
  promoted_submission_id: string | null
  promoted_at: string | null
  attachment_count: number
  body_truncated: number
}

function rowById(id: string): InboundRow | null {
  const q = d1(`SELECT * FROM inbound_emails WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as InboundRow
}

function rowsByMessageAndRecipient(messageId: string, to: string): InboundRow[] {
  const q = d1(
    `SELECT * FROM inbound_emails WHERE message_id = '${escapeSql(messageId)}' ` +
      `AND to_email = '${escapeSql(to)}'`,
  )
  return q.ok ? (q.rows as unknown as InboundRow[]) : []
}

// ═══════════════════════════════════════════════════════════════════════════

test.describe("ms-5 issue 161 the inbound seam", () => {
  // ── schema ──────────────────────────────────────────────────────────────

  test("the migration lands, and the running Worker reports the newer schema", async ({ request }) => {
    const res = await request.get(HEALTH)
    expect(res.status(), "the health probe should stay green across a migration").toBe(200)

    const health = (await res.json()) as { ok: boolean; checks: { d1: { ok: boolean; detail?: string } } }
    expect(health.ok, "GET /api/health should report the stack healthy").toBe(true)
    expect(health.checks.d1.ok, "the D1 probe should be green after the migration applies").toBe(true)

    const detail = health.checks.d1.detail ?? ""
    const version = /schema\s+(\d+)/.exec(detail)?.[1]
    expect(version, `the D1 probe should report a schema version, got "${detail}"`).toBeTruthy()
    expect(
      Number(version),
      `issue #161 adds \`migrations/0020_inbound_emails.sql\`, so the schema version should have ` +
        `moved past ${SCHEMA_HEAD_BEFORE_MS5} (0019_client_merge, the head before ms-5) — reported ` +
        `"${detail}"`,
    ).toBeGreaterThan(SCHEMA_HEAD_BEFORE_MS5)
  })

  test("inbound_emails carries the columns issue 161's own schema section names, with the nullability it pins", async () => {
    const cols = columnsOf("inbound_emails")
    expect(
      cols,
      "issue #161 creates the `inbound_emails` table — contract § \"Schema — inbound_emails\"",
    ).not.toBeNull()
    const columns = cols as Column[]
    const names = columns.map((c) => c.name)

    // Base columns EM-1's own text commits to by name, plus the routing
    // columns the contract's schema table adds so /replies (a later issue's
    // own slice) has something to read — #161's own migration must already
    // carry all of them, nullable, even though it never fills the routing
    // ones itself.
    const BASE = [
      "id",
      "message_id",
      "from_email",
      "from_name",
      "to_email",
      "subject",
      "body_text",
      "received_at",
      "auth_result",
      "disposition",
    ]
    const ROUTING = [
      "routed_kind",
      "routed_rung",
      "routed_reason",
      "routed_runner_up",
      "routed_lead_id",
      "routed_project_id",
      "routed_submission_id",
      "outbox_id",
      "promoted_submission_id",
      "promoted_at",
      "attachment_count",
      "body_truncated",
    ]

    expect(
      names,
      `inbound_emails is missing one or more of the columns contract § "Schema — inbound_emails" ` +
        `pins. Found: ${JSON.stringify(names)}`,
    ).toEqual(expect.arrayContaining([...BASE, ...ROUTING]))

    expect(column(columns, "id")?.pk, "inbound_emails.id is the PRIMARY KEY").toBe(1)

    // "message_id ... UNIQUE (message_id, to_email) where message_id is
    // present" — a message can legitimately arrive with no Message-ID header,
    // so this column must tolerate NULL.
    expect(column(columns, "message_id")?.notnull, "message_id must be nullable").toBe(0)

    // "reply-sender-name — present iff the inbound message carried a display
    // name; absent otherwise" (contract § "/replies — pinned data-testid
    // hooks") presupposes from_name can be NULL at the data layer.
    expect(column(columns, "from_name")?.notnull, "from_name must be nullable").toBe(0)

    // Every routing column is explicitly pinned nullable in the contract's own
    // schema table — #161 never fills them, only carries them.
    for (const routed of [
      "routed_kind",
      "routed_rung",
      "routed_reason",
      "routed_runner_up",
      "routed_lead_id",
      "routed_project_id",
      "routed_submission_id",
      "outbox_id",
      "promoted_submission_id",
      "promoted_at",
    ]) {
      expect(
        column(columns, routed)?.notnull,
        `${routed} must be nullable — contract § "Schema — inbound_emails" pins it nullable, and ` +
          "#161's own scope never fills it",
      ).toBe(0)
    }

    // `attachment_count INTEGER NOT NULL DEFAULT 0` and
    // `body_truncated INTEGER NOT NULL DEFAULT 0` — the two columns the
    // contract pins with an explicit NOT NULL DEFAULT, verbatim.
    for (const withDefault of ["attachment_count", "body_truncated"]) {
      const col = column(columns, withDefault)
      expect(col?.notnull, `${withDefault} is NOT NULL`).toBe(1)
      expect(
        col?.dflt_value,
        `${withDefault} defaults to 0 — contract § "Schema — inbound_emails" pins ` +
          `\`${withDefault} INTEGER NOT NULL DEFAULT 0\` verbatim`,
      ).toMatch(/^0$/)
    }
  })

  test("message_id + to_email is unique, and no foreign key constraint is introduced", async () => {
    expect(columnsOf("inbound_emails"), "the table must exist first").not.toBeNull()

    const unique = indexesOf("inbound_emails").filter((i) => i.unique === 1 && i.origin !== "pk")
    const covering = unique.filter((i) => {
      const cols = indexColumns(i.name).slice().sort()
      return cols.length === 2 && cols[0] === "message_id" && cols[1] === "to_email"
    })
    expect(
      covering.length,
      "contract § \"Schema — inbound_emails\": \"UNIQUE (message_id, to_email) where message_id " +
        `is present\" — no unique index covers exactly (message_id, to_email). Found: ` +
        `${JSON.stringify(unique.map((i) => i.name))}`,
    ).toBeGreaterThan(0)

    // "No FK constraints — this schema keeps referential integrity in the app
    // code that writes both sides in one DB.batch() (0012's own rationale)."
    const fks = d1("PRAGMA foreign_key_list(inbound_emails)")
    expect(fks.ok, "PRAGMA foreign_key_list should succeed against an existing table").toBe(true)
    expect(fks.rows.length, "issue #161 is explicit: no FK constraint on inbound_emails").toBe(0)
  })

  // ── the plain, happy path ───────────────────────────────────────────────

  test("a plain message produces exactly one inbound_emails row with the parsed fields, and touches no routing, lead, or outbox row", async ({
    request,
  }) => {
    const local = unique("plain")
    const to = `${local}-to@example.test`
    const from = `${local}-from@example.test`
    const messageId = `<${local}@example.test>`
    const before = Date.now()

    const raw = buildRawMessage({
      from: `"Priya Chandra" <${from}>`,
      to: `intake@mail.example.test`, // informational only — the envelope `?to=` is what counts
      subject: "Quick check-in",
      messageId,
      body: "Just checking in on where things stand — thanks!",
      extraHeaders: {
        // Contract: "the header that is trustworthy is the one Zoho stamped
        // for the original sender" — a single, Zoho-shaped hop.
        "Authentication-Results": "mx.zohomail.com; dmarc=pass header.from=example.test",
      },
    })

    const result = await postEmail(request, to, from, raw)
    expect(result.status, `${DOOR_UNAVAILABLE} (got HTTP ${result.status}, body: ${result.text})`).toBe(200)
    expect(result.body, `${DOOR_UNAVAILABLE} (body was not JSON: ${result.text})`).not.toBeNull()

    const body = result.body as DoorResponse
    expect(typeof body.id, "the pinned response carries a non-empty id").toBe("string")
    expect((body.id as string).length, "the id must not be empty").toBeGreaterThan(0)
    expect(body.disposition, "a plain message is never suppressed").toBe("received")

    const row = rowById(body.id as string)
    expect(row, `no inbound_emails row was found for id ${JSON.stringify(body.id)}`).not.toBeNull()
    const r = row as InboundRow

    expect(r.message_id, "message_id is the sender's Message-ID header, verbatim").toBe(messageId)
    expect(r.from_email, "from_email is the sender's address").toBe(from)
    expect(r.from_name, "from_name is the sender's display name").toBe("Priya Chandra")
    expect(
      r.to_email,
      "to_email is the envelope recipient — issue #161: \"the address it was actually delivered " +
        "to ... it must be the envelope recipient, not the To: header\"",
    ).toBe(to)
    expect(r.subject, "subject is the message's own subject line").toBe("Quick check-in")
    expect(r.body_text, "body_text is the message's own body").toBe(
      "Just checking in on where things stand — thanks!",
    )
    expect(r.disposition, "disposition matches the door's own response").toBe("received")
    expect(r.auth_result, "auth_result is the parsed DMARC verdict").toBe("pass")
    expect(r.attachment_count, "no attachment was sent").toBe(0)
    expect(r.body_truncated, "a short body is never truncated").toBe(0)

    const receivedAt = Date.parse(r.received_at ?? "")
    expect(Number.isNaN(receivedAt), `received_at ("${r.received_at}") must be a parseable date`).toBe(false)
    expect(receivedAt, "received_at should be close to when this test actually posted the message").toBeGreaterThanOrEqual(
      before - 5_000,
    )
    expect(receivedAt).toBeLessThanOrEqual(Date.now() + 5_000)

    // Issue #161's own Scope: "This issue routes nothing and replies to
    // nothing." No routing column is touched, and no leads/outbox row is
    // produced anywhere in this milestone until a later issue's own slice
    // wires the router (#163) in.
    for (const routed of [
      "routed_kind",
      "routed_rung",
      "routed_reason",
      "routed_runner_up",
      "routed_lead_id",
      "routed_project_id",
      "routed_submission_id",
      "outbox_id",
      "promoted_submission_id",
      "promoted_at",
    ] as const) {
      expect(r[routed], `${routed} must stay NULL — #161 routes nothing`).toBeNull()
    }
    expect(countWhere("leads", "email", from), "#161 never writes a leads row").toBe(0)
    expect(countWhere("outbox", "to_email", from), "#161 never writes an outbox row").toBe(0)
  })

  // ── auth_result vocabulary ──────────────────────────────────────────────

  const AUTH_CASES: Array<{ label: string; header: string | null; expected: string }> = [
    {
      label: "pass",
      header: "mx.zohomail.com; dmarc=pass header.from=example.test",
      expected: "pass",
    },
    {
      label: "fail",
      header: "mx.zohomail.com; dmarc=fail header.from=example.test",
      expected: "fail",
    },
    {
      label: "none (header absent)",
      header: null,
      expected: "none",
    },
  ]

  for (const authCase of AUTH_CASES) {
    test(`auth_result records the DMARC verdict from Authentication-Results — ${authCase.label}`, async ({
      request,
    }) => {
      const local = unique(`auth-${authCase.label.replace(/[^a-z0-9]+/gi, "-")}`)
      const to = `${local}-to@example.test`
      const from = `${local}-from@example.test`
      const messageId = `<${local}@example.test>`

      const raw = buildRawMessage({
        from,
        subject: "Following up",
        messageId,
        body: "One more thing I meant to ask.",
        extraHeaders: authCase.header ? { "Authentication-Results": authCase.header } : {},
      })

      const result = await postEmail(request, to, from, raw)
      expect(result.status, `${DOOR_UNAVAILABLE} (got HTTP ${result.status}, body: ${result.text})`).toBe(200)

      const id = (result.body as DoorResponse | null)?.id
      const row = id ? rowById(String(id)) : null
      expect(row, `no inbound_emails row was found for id ${JSON.stringify(id)}`).not.toBeNull()

      // Contract § "/replies — pinned data-testid hooks": "exactly one of
      // pass / fail / none ... A test may assert the value is one of these
      // three strings, not merely non-empty."
      expect(["pass", "fail", "none"]).toContain((row as InboundRow).auth_result)
      expect(
        (row as InboundRow).auth_result,
        `Authentication-Results ${authCase.header ? `"${authCase.header}"` : "(absent)"} should ` +
          `parse to auth_result = "${authCase.expected}"`,
      ).toBe(authCase.expected)
    })
  }

  // ── loop suppression ────────────────────────────────────────────────────

  const acceptanceEmailFrom = () => extractAddress(declaredVar("EMAIL_FROM") ?? "notify@example.test")
  const acceptanceReplyTo = () => extractAddress(declaredVar("REPLY_TO") ?? "reply@example.test")

  interface SuppressionCase {
    label: string
    build: () => { to: string; from: string; raw: string }
  }

  const SUPPRESSION_CASES: SuppressionCase[] = [
    {
      label: "Auto-Submitted: auto-replied",
      build: () => {
        const local = unique("auto-submitted")
        const to = `${local}-to@example.test`
        const from = `${local}-from@example.test`
        const raw = buildRawMessage({
          from,
          subject: "Out of office",
          messageId: `<${local}@example.test>`,
          body: "I am away and will respond when I am back.",
          extraHeaders: { "Auto-Submitted": "auto-replied" },
        })
        return { to, from, raw }
      },
    },
    {
      label: "Precedence: bulk",
      build: () => {
        const local = unique("precedence-bulk")
        const to = `${local}-to@example.test`
        const from = `${local}-from@example.test`
        const raw = buildRawMessage({
          from,
          subject: "Weekly digest",
          messageId: `<${local}@example.test>`,
          body: "This is an automated digest.",
          extraHeaders: { Precedence: "bulk" },
        })
        return { to, from, raw }
      },
    },
    {
      // TODO(test-author): contract § "Loop suppression" names List-Id and
      // List-Unsubscribe as one combined bullet ("List-Id or
      // List-Unsubscribe header present"). This slice exercises
      // List-Unsubscribe only; List-Id is presumed equivalent by the same
      // clause and is not separately tested.
      label: "List-Unsubscribe present",
      build: () => {
        const local = unique("list-unsubscribe")
        const to = `${local}-to@example.test`
        const from = `${local}-from@example.test`
        const raw = buildRawMessage({
          from,
          subject: "Newsletter",
          messageId: `<${local}@example.test>`,
          body: "Your subscription content.",
          extraHeaders: { "List-Unsubscribe": "<mailto:unsub@example.test>" },
        })
        return { to, from, raw }
      },
    },
    {
      label: "empty envelope sender (a bounce)",
      build: () => {
        const local = unique("empty-envelope-sender")
        const to = `${local}-to@example.test`
        const raw = buildRawMessage({
          from: "Mail Delivery System <mailer-daemon@example.test>",
          subject: "Undelivered Mail Returned to Sender",
          messageId: `<${local}@example.test>`,
          body: "The following message could not be delivered.",
        })
        // TODO(test-author): the contract pins "empty envelope sender (<>)"
        // as a bounce signal but does not specify how an empty envelope
        // sender is expressed through its own invented `?from=` mechanism.
        // This slice's own reading: an empty `from` query parameter value.
        return { to, from: "", raw }
      },
    },
    {
      label: "sender is one of this portal's own sending domains",
      build: () => {
        const local = unique("self-sender")
        const to = `${local}-to@example.test`
        const from = acceptanceEmailFrom()
        const raw = buildRawMessage({
          from,
          subject: "Delivery notification",
          messageId: `<${local}@example.test>`,
          body: "An automated notice from this very portal.",
        })
        // TODO(test-author): contract does not specify whether "the sender
        // address" is read from the envelope, the From: header, or both.
        // This case sets both the envelope `?from=` and the From: header to
        // the acceptance environment's own configured EMAIL_FROM address, so
        // either reading triggers suppression.
        return { to, from, raw }
      },
    },
  ]

  for (const suppressionCase of SUPPRESSION_CASES) {
    test(`loop suppression — ${suppressionCase.label} — never earns a reply`, async ({ request }) => {
      const { to, from, raw } = suppressionCase.build()
      const result = await postEmail(request, to, from, raw)
      expect(result.status, `${DOOR_UNAVAILABLE} (got HTTP ${result.status}, body: ${result.text})`).toBe(200)
      expect(result.body, `${DOOR_UNAVAILABLE} (body was not JSON: ${result.text})`).not.toBeNull()

      const body = result.body as DoorResponse
      expect(
        body.disposition,
        `contract § "Loop suppression": "${suppressionCase.label}" is independently sufficient to ` +
          `suppress a message. Response: ${JSON.stringify(body)}`,
      ).toBe("suppressed")

      const id = body.id
      const row = id ? rowById(String(id)) : null
      expect(row, "a suppressed message is still recorded, never dropped silently").not.toBeNull()
      expect((row as InboundRow).disposition, "the stored row agrees with the door's own response").toBe(
        "suppressed",
      )
      expect(
        (row as InboundRow).routed_kind,
        "a suppressed row gets no routing — issue #161's own words: \"no draft and no routing\"",
      ).toBeNull()
    })
  }

  // ── redelivery / idempotency ─────────────────────────────────────────────

  test("a redelivery of the same Message-ID produces no second row", async ({ request }) => {
    const local = unique("redelivery")
    const to = `${local}-to@example.test`
    const from = `${local}-from@example.test`
    const messageId = `<${local}@example.test>`
    const raw = buildRawMessage({
      from,
      subject: "One more thought",
      messageId,
      body: "Forwarding this again in case my first one got lost.",
    })

    const first = await postEmail(request, to, from, raw)
    expect(first.status, `${DOOR_UNAVAILABLE} (got HTTP ${first.status}, body: ${first.text})`).toBe(200)
    const firstBody = first.body as DoorResponse
    expect(typeof firstBody.id, "the first delivery gets an id").toBe("string")

    const second = await postEmail(request, to, from, raw)
    expect(
      second.status,
      `a redelivery must not error — got HTTP ${second.status}, body: ${second.text}`,
    ).toBe(200)
    const secondBody = second.body as DoorResponse

    // The response is required to carry a non-empty `id`, and #161's own
    // schema guarantees "no second row" via `UNIQUE (message_id, to_email)`.
    // The only id a compliant door can return for the redelivered message,
    // without violating either requirement, is the FIRST row's own id — a
    // second INSERT is impossible by the unique constraint, so there is
    // nothing else for a read-back to find.
    expect(
      secondBody.id,
      "a redelivery must resolve to the SAME row's id — the unique constraint forbids a second " +
        "insert, and the response contract requires a non-empty id, so the only id available to " +
        "return is the one the first delivery already produced",
    ).toBe(firstBody.id)

    const rows = rowsByMessageAndRecipient(messageId, to)
    expect(
      rows.length,
      `contract § "Schema — inbound_emails": UNIQUE (message_id, to_email) means a redelivery ` +
        `does not double-record. Found ${rows.length} row(s) for message_id=${messageId}, to=${to}`,
    ).toBe(1)
  })

  // ── size caps ────────────────────────────────────────────────────────────

  test("an oversized body is stored truncated and flagged, never dropped silently", async ({ request }) => {
    const local = unique("oversized")
    const to = `${local}-to@example.test`
    const from = `${local}-from@example.test`
    const messageId = `<${local}@example.test>`
    // No cap size is pinned by the contract ("no cap size or column name is
    // given by the issue text") — 2,000,000 characters is chosen to be safely
    // past any plausible cap while staying well under Cloudflare Workers'
    // own request-body ceiling.
    const hugeBody = "The quick brown fox jumps over the lazy dog. ".repeat(50_000)
    expect(hugeBody.length).toBeGreaterThan(1_000_000)

    const raw = buildRawMessage({
      from,
      subject: "A very long message",
      messageId,
      body: hugeBody,
    })

    const result = await postEmail(request, to, from, raw)
    expect(
      result.status,
      `an oversized message must still be accepted, never dropped silently — got HTTP ` +
        `${result.status}, body: ${result.text.slice(0, 500)}`,
    ).toBe(200)
    const body = result.body as DoorResponse
    expect(
      body.disposition,
      "issue #161: \"disposition is unaffected by truncation — a truncated message still reaches " +
        "'received'\"",
    ).toBe("received")

    const row = rowById(String(body.id))
    expect(row, `no inbound_emails row was found for id ${JSON.stringify(body.id)}`).not.toBeNull()
    const r = row as InboundRow

    expect(r.body_truncated, "body_truncated must be flagged (1) for an oversized message").toBe(1)
    expect(r.body_text, "the truncated body must not be silently dropped to empty").not.toBeNull()
    expect((r.body_text ?? "").length, "the stored body must be non-empty").toBeGreaterThan(0)
    expect(
      (r.body_text ?? "").length,
      "the stored body must actually be shorter than what was sent — otherwise nothing was capped",
    ).toBeLessThan(hugeBody.length)
    // TODO(test-author): "truncated" conventionally means the head is kept
    // and the tail is cut, but the contract does not pin which end survives.
    // This is a soft inference, not a hard contract requirement.
    expect(
      hugeBody.startsWith(r.body_text ?? "\0"),
      "the stored body is expected to be a PREFIX of what was sent (truncation cuts the tail) — " +
        "this is this slice's own inference from the ordinary meaning of \"truncated\", not a " +
        "literal contract pin",
    ).toBe(true)
  })
})
