import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect, test, type APIRequestContext } from "@playwright/test"

/**
 * ms-4 sealed acceptance slice — issue #128
 * "clients table + projects.client_id"
 *
 * Written from `tests/acceptance/ms-4/contract.md` and issue #128's own text,
 * without sight of any implementation.
 *
 * ── WHY THIS SLICE LOOKS DIFFERENT FROM EVERY OTHER SLICE IN THIS SUITE ─────
 *
 * #128 is the one issue in this milestone with **no browser surface at all**.
 * The contract says so twice, unambiguously:
 *
 *   "#128 — `clients` table + `projects.client_id`. Schema only, no route, no
 *    UI. Pinned here only as background ... No mock for this issue — there is
 *    nothing to render."
 *
 * So there is no page to `goto`, no `data-testid` to query, and no mock to
 * compare against — `mocks/` contains nothing for this issue by design. A slice
 * that drove the browser here would either assert nothing (vacuous, #1965) or
 * quietly assert #129's UI, which is a different issue's slice and a different
 * worker's job.
 *
 * What #128 actually delivers is a **migration**: after it lands, the database
 * the Worker serves from has a `clients` table and a `projects.client_id`
 * column. That is a real, externally checkable artifact, and this slice checks
 * it the same way an operator would — by asking the migrated database what
 * shape it is, through `wrangler d1 execute --local`, and by asking the running
 * Worker what schema version it is serving, through `GET /api/health`.
 *
 * Two things make that legitimate here rather than a peek at the source:
 *
 *  1. **It reads the applied schema, never the SQL text.** Nothing below opens
 *     `migrations/*.sql`. Every assertion is against the database as it exists
 *     after `serve:acceptance` has migrated it — the same database the Worker
 *     answers HTTP from. A worker who spells the migration differently, splits
 *     it across two files, or numbers it something other than 0016 passes this
 *     slice as long as the resulting schema is what #128 pins. That is the
 *     black-box/white-box line, and this slice stays on the black-box side of
 *     it.
 *  2. **This suite already reaches outside HTTP when the deliverable is
 *     outside HTTP.** `ms-2/32-bot-gate-rate-limit.spec.ts` reads
 *     `wrangler.toml`; `ms-3/51-mail-provider.spec.ts` reads `package.json`,
 *     `wrangler.toml` and shells out to `git ls-files`. Configuration and
 *     schema are both black-box surfaces that no route exposes.
 *
 * The one place #128 *is* visible over HTTP is `GET /api/health`, which reports
 * `schema <version>` from `schema_meta` — see the first test.
 *
 * ── WHAT THIS SLICE ASSERTS ─────────────────────────────────────────────────
 *
 * Exactly issue #128's four clauses, and nothing from any sibling issue:
 *
 *  1. The `clients` table exists, with the columns/types/nullability the issue
 *     pins, `id` as its primary key and `email` unique.
 *  2. `clients` is indexed by email.
 *  3. `projects` gains a nullable `client_id`, keeps everything 0012 gave it,
 *     and is indexed by `client_id`.
 *  4. The two explicit NON-goals: **no FK constraint** and **no backfill**.
 *
 * ── WHAT THIS SLICE DELIBERATELY DOES NOT ASSERT ────────────────────────────
 *
 *  - **Anything that reads or writes a `clients` row.** #128 creates no code
 *    path that does; #129 (lead promotion detects/links a client) is the only
 *    issue that ever inserts one, and its slice owns that behaviour.
 *  - **`/leads/:id`, `/account`, reassignment, start-work.** #129/#130/#131/#132.
 *  - **The "Project 1" title question** (contract § "The 'Project 1' title — a
 *    contradiction this contract does not resolve"). The contract is explicit
 *    that #128 adds `client_id` "and nothing else to `projects`", and that it
 *    will not invent a title column. This slice therefore asserts neither that
 *    a title column exists nor that it does not — see the TODO on
 *    `projects carries client_id` below.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every email below is invented and sits on RFC 6761's reserved
 * `.test` TLD.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/**
 * The schema version at the head of `migrations/` *before* this milestone —
 * `0015_preview_reviews.sql`. #128 is a migration, so whatever it is numbered,
 * the version `GET /api/health` reports has to move past this.
 */
const SCHEMA_HEAD_BEFORE_MS4 = 15

// Each test shells out to wrangler once or twice (~1.5s a call) on top of its
// HTTP work; the default 30s leaves too little headroom on a cold worker.
test.describe.configure({ timeout: 90_000 })

// ── the migrated database, as a black-box surface ───────────────────────────

/**
 * The checkout this suite is running against. Mirrors `repoRoot()` in
 * `ms-3/51-mail-provider.spec.ts` — `process.cwd()` is the Playwright config's
 * directory for both `npm run test:acceptance` and the coordinator's external
 * re-run, but walking up to the marker files makes that an assertion rather
 * than an assumption.
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
    "could not locate the repo root (no wrangler.toml + package.json) walking up from " +
      `${process.cwd()} — this slice inspects the migrated local D1, which is where issue #128's ` +
      "entire deliverable lives",
  )
}

interface D1Query {
  ok: boolean
  rows: Record<string, unknown>[]
  /** SQLite's own message when the query could not run — e.g. "no such table: clients". */
  error: string | null
}

/**
 * Ask the **migrated** local D1 a read-only question.
 *
 * This is the same database `serve:acceptance` created (it wipes
 * `.wrangler/state`, applies every migration, then serves from the result), so
 * what this sees is exactly what the Worker under test is serving from — not a
 * separate copy, and not the SQL source.
 *
 * READ-ONLY, deliberately. Nothing in this slice writes through this channel.
 * CLAUDE.md's determinism rule ("never write a test that depends on rows
 * another test left behind") cuts both ways: a sealed test that injected rows
 * directly into a shared D1 could contaminate a sibling slice — #129's client
 * lookup, say — in a suite that runs single-worker with no retries, and the
 * failure would surface as someone else's flake. Every row this slice cares
 * about is created through the real HTTP surface instead.
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
    // wrangler exits non-zero on a SQL error but still reports it as JSON on
    // stdout: `{"error": {"text": "no such table: clients: SQLITE_ERROR"}}`.
    // That is a result to assert on, not a crash to rethrow.
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
  pk: number
}

/** `PRAGMA table_info(<table>)`, or `null` when the table does not exist. */
function columnsOf(table: string): Column[] | null {
  const q = d1(`PRAGMA table_info(${table})`)
  if (!q.ok) return null
  // A PRAGMA against a table SQLite has never heard of is not an error — it
  // succeeds with zero rows. That is indistinguishable, here, from "absent".
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

/** The column names an index actually covers, in order. */
function indexColumns(index: string): string[] {
  const q = d1(`PRAGMA index_info("${index}")`)
  return q.ok ? q.rows.map((r) => String(r.name)) : []
}

// ── the HTTP surface, used only to create a genuine `projects` row ──────────

/**
 * File a request through `POST /intake` and return the submission id it
 * redirects to.
 *
 * `/intake` and its `?from=` follow-up are ms-1 surfaces, already pinned by
 * `ms-1/09-intake.spec.ts` and issue #109 — used here purely as an
 * **instrument** for creating a real `projects` row the ordinary way, exactly
 * as `ms-2/33-lead-triage-promotion.spec.ts` uses `POST /start` to seed leads.
 * Nothing about the intake screen itself is asserted by this slice.
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
      audience: "The team that owns this surface",
      doneDefinition: "It is live and nobody has to explain it twice",
    },
    maxRedirects: 0,
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
 * Create one project the only way a customer can (#109: a follow-up filed from
 * an existing submission is the single deliberate trigger for a project) and
 * return its `proj_…` id, read from the dashboard's own `project-row` link.
 *
 * This matters for the no-backfill clause: the project that comes back has
 * been created **entirely outside** anything #128 or #129 touches, which is
 * precisely the population the issue says must be left alone.
 */
async function createProjectViaFollowUp(
  request: APIRequestContext,
  email: string,
): Promise<{ projectId: string; originId: string; followUpId: string }> {
  const originId = await fileRequest(request, email, "A storefront that loads before the customer gives up")
  const followUpId = await fileRequest(request, email, "The same storefront, now with a checkout", originId)

  const dashboard = await request.get("/submissions", { headers: { [ACCESS_HEADER]: email } })
  expect(dashboard.status(), "the dashboard should render for the caller who just filed").toBe(200)
  const body = await dashboard.text()

  const projectId = /href="\/projects\/([A-Za-z0-9_-]+)"/.exec(body)?.[1]
  expect(
    projectId,
    "a follow-up should have produced a project reachable from the dashboard (issue #109) — " +
      "this slice needs one to assert #128's no-backfill clause against",
  ).toBeTruthy()

  return { projectId: projectId as string, originId, followUpId }
}

test.describe("ms-4 issue 128 clients table and projects.client_id", () => {
  /**
   * The one clause of #128 that is visible over HTTP.
   *
   * Every migration 0001–0015 ends by writing its own number to
   * `schema_meta.schema_version`, and `GET /api/health` reports it verbatim as
   * `schema <version>` (it is the D1 probe's whole payload). So "the migration
   * landed" is externally observable without reading a single line of SQL.
   *
   * TODO(test-author): neither #128 nor the contract restates the
   * `schema_meta` bump — it is inferred from all fifteen existing migrations
   * doing it and from `/api/health` being built to surface it. A worker who
   * ships `clients` without bumping the version would fail here while
   * satisfying the issue's literal SQL block. That is judged the right call
   * rather than a gap: an unbumped version makes the health endpoint report a
   * schema the database is not at, which is a defect in its own right. Flagged
   * so it can be amended in the contract rather than worked around here.
   */
  test("the migration lands, and the running Worker reports the newer schema", async ({ request }) => {
    const res = await request.get("/api/health")
    expect(res.status(), "the health probe should stay green across a migration").toBe(200)

    const health = (await res.json()) as {
      ok: boolean
      checks: { d1: { ok: boolean; detail?: string } }
    }

    // A half-applied migration shows up here first: the D1 probe is what
    // `serve:acceptance` gates the whole suite on.
    expect(health.ok, "GET /api/health should report the stack healthy").toBe(true)
    expect(health.checks.d1.ok, "the D1 probe should be green after the migration applies").toBe(true)

    const detail = health.checks.d1.detail ?? ""
    const version = /schema\s+(\d+)/.exec(detail)?.[1]
    expect(version, `the D1 probe should report a schema version, got "${detail}"`).toBeTruthy()
    expect(
      Number(version),
      `issue #128 adds a migration, so the schema version should have moved past ` +
        `${SCHEMA_HEAD_BEFORE_MS4} (0015_preview_reviews, the head before ms-4) — reported "${detail}"`,
    ).toBeGreaterThan(SCHEMA_HEAD_BEFORE_MS4)
  })

  test("a clients table exists at schema head", async () => {
    const cols = columnsOf("clients")
    expect(
      cols,
      "issue #128 creates a `clients` table — there is no row anywhere today that represents " +
        "'this customer', and this is the table that fixes it",
    ).not.toBeNull()
  })

  /**
   * The column list, verbatim from the issue's own DDL block:
   *
   *   id TEXT PRIMARY KEY / email TEXT NOT NULL UNIQUE / phone TEXT /
   *   cc_emails TEXT / address TEXT / created_at TEXT NOT NULL
   *
   * `phone`, `cc_emails` and `address` are asserted **nullable** rather than
   * merely present: they are the profile facts #131 lets a client fill in
   * later, so a client must be creatable — by #129's promotion path — with
   * none of them known.
   */
  test("clients carries exactly the columns issue 128 pins, with the nullability it pins", async () => {
    const cols = columnsOf("clients")
    expect(cols, "the `clients` table must exist before its shape can be asserted").not.toBeNull()
    const columns = cols as Column[]

    expect(
      columns.map((c) => c.name).sort(),
      "issue #128 pins the `clients` column list exactly",
    ).toEqual(["address", "cc_emails", "created_at", "email", "id", "phone"])

    for (const name of ["id", "email", "phone", "cc_emails", "address", "created_at"]) {
      expect(column(columns, name)?.type.toUpperCase(), `clients.${name} should be TEXT`).toBe("TEXT")
    }

    expect(column(columns, "id")?.pk, "clients.id is the PRIMARY KEY").toBe(1)
    expect(column(columns, "email")?.notnull, "clients.email is NOT NULL").toBe(1)
    expect(column(columns, "created_at")?.notnull, "clients.created_at is NOT NULL").toBe(1)

    for (const optional of ["phone", "cc_emails", "address"]) {
      expect(
        column(columns, optional)?.notnull,
        `clients.${optional} is optional — a client created by lead promotion (#129) knows only ` +
          "an email, and fills these in later via /account (#131)",
      ).toBe(0)
    }
  })

  /**
   * `email TEXT NOT NULL UNIQUE`.
   *
   * Asserted through SQLite's own index catalogue rather than by attempting a
   * duplicate INSERT, for the determinism reason in `d1()`'s comment: this
   * slice never writes to the shared acceptance database.
   *
   * Deliberately tolerant of *how* uniqueness is declared — a `UNIQUE` column
   * constraint (`origin: "u"`) and a standalone `CREATE UNIQUE INDEX`
   * (`origin: "c"`) both satisfy "two clients cannot share an email address",
   * which is the property the issue is actually buying. Only a primary-key
   * index is excluded, since #128 pins `id` as the PK.
   */
  test("no two clients can share an email address", async () => {
    expect(columnsOf("clients"), "the `clients` table must exist first").not.toBeNull()

    const unique = indexesOf("clients").filter((i) => i.unique === 1 && i.origin !== "pk")
    const coveringEmail = unique.filter((i) => {
      const cols = indexColumns(i.name)
      return cols.length === 1 && cols[0] === "email"
    })

    expect(
      coveringEmail.length,
      "issue #128 pins `email TEXT NOT NULL UNIQUE` — one client, one email address. " +
        `Unique non-PK indexes found on clients: ${JSON.stringify(unique.map((i) => i.name))}`,
    ).toBeGreaterThan(0)
  })

  test("clients is indexed by email", async () => {
    expect(columnsOf("clients"), "the `clients` table must exist first").not.toBeNull()

    const names = indexesOf("clients").map((i) => i.name)
    expect(
      names,
      "issue #128 pins `CREATE INDEX idx_clients_email ON clients (email)` — the lookup #129's " +
        `promotion path makes on every lead. Indexes present: ${JSON.stringify(names)}`,
    ).toContain("idx_clients_email")
    expect(indexColumns("idx_clients_email"), "idx_clients_email covers clients(email)").toEqual(["email"])
  })

  /**
   * TODO(test-author): this asserts `client_id` is *added* and that 0012's
   * three columns survive, but deliberately does NOT assert that `client_id`
   * is the only new column. The contract's § "The 'Project 1' title" section
   * flags a live contradiction — #129's prose asks for a project "titled
   * 'Project 1'" while 0012 is explicit that `projects` has no title column —
   * and says a worker who adds a stored title "is not violating this contract,
   * but is also not implementing anything #128 scopes". An exact-column-list
   * assertion here would silently convert that open question into a failure
   * belonging to a different issue, so it is left open on purpose.
   */
  test("projects carries a nullable client_id, and keeps everything 0012 gave it", async () => {
    const cols = columnsOf("projects")
    expect(cols, "`projects` predates this milestone (0012) and must still exist").not.toBeNull()
    const columns = cols as Column[]

    const clientId = column(columns, "client_id")
    expect(
      clientId,
      "issue #128 pins `ALTER TABLE projects ADD COLUMN client_id TEXT` — the link from a project " +
        `to the customer it belongs to. Columns present: ${JSON.stringify(columns.map((c) => c.name))}`,
    ).toBeTruthy()
    expect(clientId?.type.toUpperCase(), "projects.client_id is TEXT").toBe("TEXT")
    expect(
      clientId?.notnull,
      "projects.client_id must be nullable — issue #128 does no backfill, so every project that " +
        "predates this migration keeps `client_id = NULL`",
    ).toBe(0)

    // The ALTER must be additive: 0012's own columns are what every existing
    // screen (`/projects/:id`, the dashboard) still reads.
    for (const kept of ["id", "customer_email", "created_at"]) {
      expect(column(columns, kept), `projects.${kept} (migration 0012) must survive the ALTER`).toBeTruthy()
    }
  })

  test("projects is indexed by client_id", async () => {
    expect(columnsOf("projects"), "`projects` must exist first").not.toBeNull()

    const names = indexesOf("projects").map((i) => i.name)
    expect(
      names,
      "issue #128 pins `CREATE INDEX idx_projects_client_id ON projects (client_id)` — the scan " +
        "behind `SELECT * FROM projects WHERE client_id = ?`, which the contract makes the basis " +
        `of both project lists in #129 and #130. Indexes present: ${JSON.stringify(names)}`,
    ).toContain("idx_projects_client_id")
    expect(indexColumns("idx_projects_client_id"), "idx_projects_client_id covers projects(client_id)").toEqual([
      "client_id",
    ])
  })

  /**
   * Issue #128, "What this explicitly does NOT do": **no FK constraint**.
   *
   * "Matches every other cross-table reference in this schema
   * (`leads.promoted_submission_id`, `design_rounds.submission_id`,
   * `submissions.project_id`) — referential integrity lives in the app code
   * that writes both sides inside one `DB.batch()`, not in a constraint."
   *
   * This is not a stylistic preference: a real FK on `projects.client_id`
   * would make the batched two-sided writes this codebase relies on
   * order-dependent, and would make deleting a client fail rather than orphan.
   */
  test("no foreign key constraint is introduced on either table", async () => {
    expect(columnsOf("clients"), "the `clients` table must exist first").not.toBeNull()

    const clientFks = d1("PRAGMA foreign_key_list(clients)")
    expect(
      clientFks.rows,
      "issue #128 is explicit that it adds no FK — this schema keeps referential integrity in the " +
        "app code that writes both sides inside one DB.batch()",
    ).toEqual([])

    const projectFks = d1("PRAGMA foreign_key_list(projects)")
    expect(
      projectFks.rows,
      "`ALTER TABLE projects ADD COLUMN client_id TEXT` — no REFERENCES clause, matching " +
        "`submissions.project_id` and `leads.promoted_submission_id`",
    ).toEqual([])
  })

  /**
   * Issue #128, "What this explicitly does NOT do": **no backfill**.
   *
   * "Every existing `projects`/`submissions` row keeps its bare
   * `customer_email` string and gets `client_id = NULL`. Retroactively
   * inventing client records for historical data is a separate decision."
   *
   * The contract leans on this hard — § "Which projects are even offered"
   * says a project created "via a customer's own 'Start a follow-up' action
   * ... shares the client's `customer_email` but has `client_id IS NULL` (#128:
   * no backfill, no inference from a matching email) and will **not** appear in
   * either list."
   *
   * So this test builds exactly that row, through the real HTTP surface, and
   * checks both halves of the sentence: `client_id` is NULL, and
   * `customer_email` is untouched.
   */
  test("no backfill — a project created outside lead promotion has a NULL client_id and keeps its email", async ({
    request,
  }) => {
    const email = "no-backfill-128@example.test"
    const { projectId } = await createProjectViaFollowUp(request, email)

    const q = d1(`SELECT id, customer_email, client_id FROM projects WHERE id = '${projectId}'`)
    expect(
      q.ok,
      `reading the project back should succeed once #128's column exists — SQLite said: ${q.error}`,
    ).toBe(true)
    expect(q.rows.length, `the project ${projectId} the dashboard just linked to should exist`).toBe(1)

    const row = q.rows[0]
    expect(
      row.client_id,
      "issue #128 does no backfill: a project created by the ordinary follow-up flow (#109) has " +
        "never been through lead promotion, so nothing may have invented a client for it",
    ).toBeNull()
    expect(
      row.customer_email,
      "the bare `customer_email` string stays exactly where it was — #128 adds a column, it does " +
        "not migrate the data off the old one",
    ).toBe(email)
  })

  /**
   * RATCHET — expected to be GREEN both before and after #128, and therefore
   * correctly absent from the manifest's `expected_red` block (observed, not
   * intended).
   *
   * Same clause, the other table named in it: "Every existing
   * `projects`/`submissions` row keeps its bare `customer_email` string".
   *
   * A submission has no `client_id` of its own in #128's DDL at all — the link
   * is `submissions → projects → clients` — so there is no new column here to
   * be missing, and nothing about this can be red before the migration lands.
   * What it guards is the destructive reading of #128: a worker who decided to
   * "tidy up" by moving `customer_email` onto the new client row and nulling
   * the old column would satisfy every red test above and fail this one, which
   * is exactly the point of keeping it.
   */
  test("no backfill — a submission keeps the bare customer_email it was filed with", async ({ request }) => {
    const email = "untouched-email-128@example.test"
    const submissionId = await fileRequest(request, email, "A landing page that survives a launch day")

    const q = d1(`SELECT id, customer_email FROM submissions WHERE id = '${submissionId}'`)
    expect(q.ok, `reading the submission back should succeed — SQLite said: ${q.error}`).toBe(true)
    expect(q.rows.length, "the submission just filed should exist").toBe(1)
    expect(
      q.rows[0].customer_email,
      "#128 introduces client identity alongside `customer_email`, never in place of it — " +
        "nothing is rewritten, nothing is nulled out",
    ).toBe(email)
  })

  /**
   * CONTROL / RATCHET — expected to be GREEN both before and after #128.
   *
   * A migration's most likely way to go wrong is not "the column is missing",
   * it is "the column landed and something that reads the table broke". This
   * test drives the ms-1/#109 surfaces that read `projects` and `submissions`
   * end to end and asserts they still render.
   *
   * It is green today (those features are built) and must stay green, so by
   * the observed-not-intended rule it is correctly absent from the manifest's
   * `expected_red` block. Its job is to fail loudly if #128's ALTER breaks a
   * `SELECT *` somewhere.
   */
  test("the migration disturbs nothing that already reads projects and submissions", async ({ request }) => {
    const email = "ratchet-128@example.test"
    const { projectId, originId, followUpId } = await createProjectViaFollowUp(request, email)

    const project = await request.get(`/projects/${projectId}`, { headers: { [ACCESS_HEADER]: email } })
    expect(project.status(), "the project detail screen (#109) must keep rendering").toBe(200)
    const projectBody = await project.text()
    expect(projectBody, "the project screen is still the combined view #109 built").toContain(
      'data-testid="project-detail"',
    )

    for (const id of [originId, followUpId]) {
      const detail = await request.get(`/submissions/${id}`, { headers: { [ACCESS_HEADER]: email } })
      expect(detail.status(), `submission ${id} must still be readable by its owner`).toBe(200)
    }

    const dashboard = await request.get("/submissions", { headers: { [ACCESS_HEADER]: email } })
    expect(dashboard.status(), "the customer dashboard must keep rendering").toBe(200)
  })
})
