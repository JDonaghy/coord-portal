import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #120 — the upload half of the mock bundle
 * bridge, `POST /api/bridge/mocks/:reference/:round` (`src/routes/mocks.ts`).
 * Driven against the real Worker under `wrangler dev`, with real local D1 and
 * R2 — see `playwright.config.ts` — because the interesting behaviour here
 * (writing real objects into R2, reading `design_rounds` to refuse a decided
 * round) is exactly the part `test/bridge.test.ts`'s mocked D1/R2 cannot tell
 * the truth about.
 *
 * This route only ever writes R2 objects and hands back the key it used —
 * recording that key against a round is a separate, ordinary
 * `POST /api/bridge/push` (`design_round.mock_bundle`), exactly as PDR-3
 * (`JDonaghy/claude-coordinator#2508`) will do it. `publishRound` below plays
 * that second step so the round-trip through `GET /submissions/:id/rounds/:n/mock`
 * (`e2e/design-rounds.spec.ts`'s route) can be exercised for real.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "c39d5a17e084b6f2a917cd063af8b4e51.access",
  "CF-Access-Client-Secret":
    "6e2b8f0c4a1d975e3fb6408adc27e0f19a3c8d1e5f072b6a4c9de813f6a209b1",
}

/** `serve:test` does not wipe state between runs — see `e2e/bridge.spec.ts`. */
function uniqueEmail(local: string): string {
  const tag = Math.random().toString(36).slice(2, 10)
  return `${local}-${tag}@example.test`
}

interface Seeded {
  url: string
  id: string
  reference: string
}

async function seedSubmission(page: Page, email: string): Promise<Seeded> {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill("A synthetic outcome for mock-upload e2e coverage.")
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The mock-upload e2e suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const reference = (await page.getByTestId("submission-reference").innerText())
    .trim()
    .replace(/^Reference\s+/, "")
  const url = page.url()
  return { url, id: url.split("/submissions/")[1] ?? "", reference }
}

async function push(
  request: APIRequestContext,
  reference: string,
  revision: number,
  fields: Record<string, unknown>,
): Promise<{ outcome: string; reason?: string }> {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: reference, revision, fields }] },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { results: Array<{ outcome: string; reason?: string }> }
  const result = body.results[0]
  if (!result) throw new Error("push produced no result")
  return result
}

/**
 * Opens round 1 and asks for sign-off, exactly as `design-rounds.spec.ts`
 * does. Every caller below is a fresh submission's first push, so the
 * implicit "no round named -> land on round 1" rule (`roundStatementsForPush`,
 * `src/rounds.ts`) is all that is needed — no explicit round number.
 */
async function publishRound(
  request: APIRequestContext,
  reference: string,
  mockBundle: string,
): Promise<void> {
  const result = await push(request, reference, 1, {
    design_round: {
      outcome_definition: "Let a coordinator drop in a list of contacts and see them appear.",
      decomposition: ["An upload step with a preview"],
      mock_bundle: mockBundle,
    },
    status: "awaiting-signoff",
  })
  expect(result.outcome).toBe("applied")
}

interface UploadResult {
  status: number
  body: { key?: string; files?: string[]; error?: string; limit?: number; field?: string }
}

async function upload(
  request: APIRequestContext,
  reference: string,
  round: number,
  files: Record<string, { mimeType: string; buffer: Buffer }>,
  headers: Record<string, string> = SERVICE_TOKEN,
): Promise<UploadResult> {
  const res = await request.post(`/api/bridge/mocks/${reference}/${round}`, {
    multipart: Object.fromEntries(
      Object.entries(files).map(([name, file]) => [
        name,
        { name: name.split("/").pop() ?? name, mimeType: file.mimeType, buffer: file.buffer },
      ]),
    ),
    headers,
  })
  return { status: res.status(), body: (await res.json()) as UploadResult["body"] }
}

const INDEX_HTML = {
  mimeType: "text/html",
  buffer: Buffer.from(
    "<!doctype html><title>synthetic mock</title><p>hello from the uploaded bundle</p>",
  ),
}
const TOKENS_CSS = { mimeType: "text/css", buffer: Buffer.from("body { color: blue }") }
const CONTRACT_MD = {
  mimeType: "text/markdown",
  buffer: Buffer.from("# Contract\n\nWhat this round's mock demonstrates."),
}

test("the daemon uploads a bundle, gets back the key, and it serves for real once a round points at it", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-upload-happy")
  const seeded = await seedSubmission(page, email)

  const result = await upload(request, seeded.reference, 1, {
    "index.html": INDEX_HTML,
    "tokens.css": TOKENS_CSS,
    "contract.md": CONTRACT_MD,
  })

  expect(result.status).toBe(200)
  expect(result.body.key).toBe(`rounds/${seeded.reference}/1`)
  expect(result.body.files).toEqual(["contract.md", "index.html", "tokens.css"])

  // The key this route handed back is exactly what a real push would carry —
  // PDR-3's job, played here so the round-trip is provable end to end.
  await publishRound(request, seeded.reference, result.body.key!)

  const identity = { "Cf-Access-Authenticated-User-Email": email }
  const bundlePath = `/submissions/${seeded.id}/rounds/1/mock`

  const doc = await request.get(bundlePath, { headers: identity })
  expect(doc.status()).toBe(200)
  expect(await doc.text()).toContain("hello from the uploaded bundle")

  const css = await request.get(`${bundlePath}/tokens.css`, { headers: identity })
  expect(css.status()).toBe(200)
  expect(await css.text()).toBe("body { color: blue }")

  const contract = await request.get(`${bundlePath}/contract.md`, { headers: identity })
  expect(contract.status()).toBe(200)
  expect(contract.headers()["content-type"]).toBe("text/plain; charset=utf-8")
})

test("refuses an upload with no service token, same as the other three bridge routes", async ({
  request,
}) => {
  // The gate answers every rejection the same way — an empty body, no detail
  // — so this bypasses the `upload()` helper's `res.json()`, which a 401 here
  // has nothing for it to parse (see `bridgeUnauthorized`, `src/bridge/auth.ts`).
  const res = await request.post("/api/bridge/mocks/SUB-000000/1", {
    multipart: { "index.html": { name: "index.html", mimeType: "text/html", buffer: INDEX_HTML.buffer } },
  })
  expect(res.status()).toBe(401)
  expect(await res.text()).toBe("")
})

test("refuses a bundle for a submission reference that does not exist", async ({ request }) => {
  const res = await upload(request, "SUB-NOTREAL", 1, { "index.html": INDEX_HTML })
  expect(res.status).toBe(404)
  expect(res.body).toMatchObject({ error: "unknown_submission" })
})

test("refuses a bundle with no index.html — it would 404 on every request it could ever serve", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-upload-noindex"))
  const res = await upload(request, seeded.reference, 1, { "tokens.css": TOKENS_CSS })
  expect(res.status).toBe(400)
  expect(res.body).toMatchObject({ error: "missing_index_html" })
})

test("refuses a file path that tries to climb out of the round's own subtree", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-upload-traversal"))
  const res = await upload(request, seeded.reference, 1, {
    "index.html": INDEX_HTML,
    "../../outside/secret.html": INDEX_HTML,
  })
  expect(res.status).toBe(400)
  expect(res.body).toMatchObject({ error: "invalid_path" })
})

test("refuses to overwrite the bytes behind a round the customer has already decided", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-upload-decided")
  const seeded = await seedSubmission(page, email)

  const first = await upload(request, seeded.reference, 1, {
    "index.html": INDEX_HTML,
    "tokens.css": TOKENS_CSS,
  })
  expect(first.status).toBe(200)
  await publishRound(request, seeded.reference, first.body.key!)

  // The customer approves round 1 — it now has a verdict.
  await page.goto(seeded.url)
  await page.getByTestId("approve-button").click()
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "planned")

  const REVISED_INDEX = {
    mimeType: "text/html",
    buffer: Buffer.from("<!doctype html><p>a revised bundle that must never land</p>"),
  }
  const second = await upload(request, seeded.reference, 1, { "index.html": REVISED_INDEX })
  expect(second.status).toBe(409)
  expect(second.body).toMatchObject({ error: "round_decided" })

  // The original bytes are still exactly what was approved.
  const identity = { "Cf-Access-Authenticated-User-Email": email }
  const doc = await request.get(`/submissions/${seeded.id}/rounds/1/mock`, { headers: identity })
  expect(await doc.text()).toContain("hello from the uploaded bundle")
})

test("a round nothing has been pushed for yet is still open to upload", async ({
  page,
  request,
}) => {
  // The upload can legitimately arrive before the round metadata does — this
  // route never reads or writes `design_rounds`, so there is nothing pending
  // for it to be blocked by.
  const seeded = await seedSubmission(page, uniqueEmail("e2e-upload-first"))
  const res = await upload(request, seeded.reference, 1, { "index.html": INDEX_HTML })
  expect(res.status).toBe(200)
  expect(res.body.key).toBe(`rounds/${seeded.reference}/1`)
})
