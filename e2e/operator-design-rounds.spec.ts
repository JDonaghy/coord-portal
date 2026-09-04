import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

import { seedR2Object } from "./r2-fixtures"
import { runWrangler } from "./wrangler-cli"

/**
 * Black-box coverage for issue #304 ([portal] Operators cannot see a
 * customer's design round), driving the real Worker under `wrangler dev`
 * with real local D1 and R2 — see `playwright.config.ts`. This is the
 * project's own `e2e/` tier, not the sealed acceptance suite under
 * `tests/acceptance/`; per CLAUDE.md this repo still ships its own black-box
 * coverage for behaviour-changing work.
 *
 * Before this issue, an operator reviewing a `changes-requested` verdict
 * could read the comment (`coord journal`) but never open the mock it was
 * about: `routes/mocks.ts`'s bundle route and `routes/submission.ts`'s round
 * history both gated on `isOwnedBy` alone. `routes/requests.ts`'s
 * `requestRounds` (`GET /requests/:id/rounds`) and `routes/mocks.ts`'s
 * `operatorMockBundle` (`GET /requests/:id/rounds/:n/mock`) are the fix.
 *
 * WHAT THIS FILE PROVES:
 *
 *   OPERATOR CAN OPEN IT   the round list shows verdict, comment and decision
 *                          timestamp, and the same bundle bytes the customer
 *                          route serves are reachable through the operator
 *                          route too — same CSP, same headers.
 *   GATED, NOT WIDENED     a stranger, a signed-out caller, and the
 *                          submission's own *customer* (not also configured
 *                          as an operator) all get the exact same 404 —
 *                          never a 403, and never distinguishable from one
 *                          another. `isOwnedBy` itself is untouched: the
 *                          customer's own routes keep working exactly as
 *                          `e2e/design-rounds.spec.ts` already proves.
 *   CLEARLY MARKED         the round-history page says, in rendered copy,
 *                          that this is an operator reading customer
 *                          material.
 *   AUDITED                every operator read lands a row in
 *                          `operator_reads` (`src/operatorAccess.ts`).
 *   RENDERS CLEANLY        a submission with no rounds, and a round with no
 *                          bundle, both 200 with an empty state — never an
 *                          error.
 *
 * Every address and string below is invented, on the reserved `example.test`
 * TLD — CLAUDE.md rule 1. `serve:test` does not wipe `.wrangler/state`
 * between runs, so identities are tagged unique per run rather than risking a
 * row a previous run left behind.
 */

const DEV_OPERATOR = "ops@example.test"

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "d5a3f097c1e6b4285fd9013ac74e2b5f8.access",
  "CF-Access-Client-Secret":
    "7c1f4b8e0a3d6952f81be047c39ad26510f7a9c3e6b085d2f491ca8e07b3d6c",
}

const DATABASE = "coord-portal"

function uniqueEmail(local: string): string {
  const tag = Math.random().toString(36).slice(2, 10)
  return `${local}-${tag}@example.test`
}

interface Seeded {
  url: string
  id: string
  reference: string
}

async function seedSubmission(page: Page, email: string, tag: string): Promise<Seeded> {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/intake")
  await page
    .getByTestId("field-outcome")
    .fill(`A synthetic outcome for e2e operator-round coverage (${tag}).`)
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The operator-round e2e suite goes green.")
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
): Promise<{ outcome: string }> {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: reference, revision, fields }] },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { results: Array<{ outcome: string }> }
  const result = body.results[0]
  if (!result) throw new Error("push produced no result")
  return result
}

interface RoundContent {
  outcome_definition: string
  decomposition: string[]
  mock_bundle?: string
}

async function publishRound(
  request: APIRequestContext,
  reference: string,
  revision: number,
  round: RoundContent,
): Promise<void> {
  const result = await push(request, reference, revision, {
    design_round: round,
    status: "awaiting-signoff",
  })
  expect(result.outcome).toBe("applied")
}

function operatorHeaders(email: string): Record<string, string> {
  return { "Cf-Access-Authenticated-User-Email": email }
}

/** Reads `operator_reads` rows for one submission back out of the same local D1 the Worker writes to. */
function operatorReadsFor(reference: string): Array<{ operator_email: string; round: number | null }> {
  const output = runWrangler([
    "d1",
    "execute",
    DATABASE,
    "--local",
    "--json",
    "--command",
    `SELECT operator_email, round FROM operator_reads WHERE submission_id = '${reference}' ORDER BY occurred_at ASC`,
  ])
  const [{ results }] = JSON.parse(output) as [
    { results: Array<{ operator_email: string; round: number | null }> },
  ]
  return results
}

test.describe("the operator round read (routes/requests.ts, routes/mocks.ts — issue #304)", () => {
  test("an operator sees the round list — verdict, comment, decision time — and the same bundle bytes the customer route serves", async ({
    page,
    request,
  }) => {
    const customerEmail = uniqueEmail("e2e-op-round-customer")
    const seeded = await seedSubmission(page, customerEmail, "happy-path")

    const indexKey = `rounds/${seeded.reference}/1/index.html`
    seedR2Object(
      indexKey,
      "<!doctype html><title>synthetic mock</title><p>hello from the operator's view of the bundle</p>",
      "text/html; charset=utf-8",
    )
    await publishRound(request, seeded.reference, 1, {
      outcome_definition: "Let an operator open a customer's design round.",
      decomposition: ["A round history the operator can actually read"],
      mock_bundle: indexKey,
    })

    // The customer requests changes — a decided round with a comment, so the
    // operator screen has a verdict, a comment and a decision timestamp to
    // show, not just a pending one.
    await page.goto(seeded.url)
    await page.getByTestId("request-changes-button").click()
    await page.getByTestId("changes-comment").fill("Please use our real brand colours, not the placeholder.")
    await page.getByTestId("submit-changes").click()
    await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "in-design")

    // The operator's round-history page.
    const roundsPage = await request.get(`/requests/${seeded.id}/rounds`, {
      headers: operatorHeaders(DEV_OPERATOR),
    })
    expect(roundsPage.status()).toBe(200)
    const roundsBody = await roundsPage.text()

    expect(roundsBody).toContain('data-testid="operator-access-notice"')
    expect(roundsBody).toContain(customerEmail)

    expect(roundsBody).toContain('data-round="1"')
    expect(roundsBody).toContain('data-verdict="changes-requested"')
    expect(roundsBody).toContain("Please use our real brand colours, not the placeholder.")
    expect(roundsBody).toContain('data-testid="round-decided-at"')
    expect(roundsBody).toContain(`data-testid="operator-mock-bundle-link"`)
    expect(roundsBody).toContain(`href="/requests/${seeded.id}/rounds/1/mock"`)

    // The bundle itself, through the operator route — same bytes, same
    // headers `e2e/design-rounds.spec.ts` pins for the customer route.
    const bundlePath = `/requests/${seeded.id}/rounds/1/mock`
    const doc = await request.get(bundlePath, { headers: operatorHeaders(DEV_OPERATOR) })
    expect(doc.status()).toBe(200)
    expect(doc.headers()["content-type"]).toBe("text/html; charset=utf-8")
    expect(doc.headers()["x-content-type-options"]).toBe("nosniff")
    expect(doc.headers()["content-security-policy"]).toBe(
      "default-src 'self'; script-src 'none'; frame-ancestors 'self'",
    )
    expect(doc.headers()["cache-control"]).toBe("private, no-store")
    const operatorBody = await doc.text()
    expect(operatorBody).toContain("hello from the operator's view of the bundle")

    // Byte-identical to what the customer's own route serves for the same round.
    const customerDoc = await request.get(`/submissions/${seeded.id}/rounds/1/mock`, {
      headers: operatorHeaders(customerEmail),
    })
    expect(customerDoc.status()).toBe(200)
    expect(await customerDoc.text()).toBe(operatorBody)

    // Both reads left a trace.
    const reads = operatorReadsFor(seeded.reference)
    expect(reads).toContainEqual({ operator_email: DEV_OPERATOR, round: null })
    expect(reads).toContainEqual({ operator_email: DEV_OPERATOR, round: 1 })
  })

  test("a stranger, a signed-out caller, and the submission's own customer all get the same 404 — never a 403", async ({
    page,
    request,
  }) => {
    const customerEmail = uniqueEmail("e2e-op-round-owner")
    const seeded = await seedSubmission(page, customerEmail, "gated")

    const indexKey = `rounds/${seeded.reference}/1/index.html`
    seedR2Object(indexKey, "<!doctype html><p>operator-only content</p>", "text/html; charset=utf-8")
    await publishRound(request, seeded.reference, 1, {
      outcome_definition: "A synthetic outcome nobody but an operator should read.",
      decomposition: ["A single work item"],
      mock_bundle: indexKey,
    })

    const strangerEmail = uniqueEmail("e2e-op-round-stranger")
    const roundsPath = `/requests/${seeded.id}/rounds`
    const bundlePath = `/requests/${seeded.id}/rounds/1/mock`

    for (const path of [roundsPath, bundlePath]) {
      const stranger = await request.get(path, { headers: operatorHeaders(strangerEmail) })
      // The submission's own customer — signed in as themselves, not an
      // operator. Issue #304's own constraint: "an owner's own access is
      // unchanged" means unchanged on their *own* route; it does not mean
      // their identity satisfies the *operator* gate on this one.
      const owner = await request.get(path, { headers: operatorHeaders(customerEmail) })
      const signedOut = await request.get(path)

      for (const res of [stranger, owner, signedOut]) expect(res.status()).toBe(404)

      const bodies = await Promise.all([stranger.text(), owner.text(), signedOut.text()])
      expect(new Set(bodies).size).toBe(1)
      for (const body of bodies) {
        expect(body).not.toContain("operator-only content")
        expect(body).not.toContain(customerEmail)
      }
    }

    // None of those refused requests left an audit trace — only a caller who
    // actually cleared the operator gate does.
    expect(operatorReadsFor(seeded.reference)).toEqual([])

    // The owner's own customer-facing route is completely unaffected by any
    // of this — `e2e/design-rounds.spec.ts` already proves the general case;
    // this is the one-line regression check that adding the operator route
    // did not touch it.
    const ownRoute = await request.get(`/submissions/${seeded.id}/rounds`, {
      headers: operatorHeaders(customerEmail),
    })
    expect(ownRoute.status()).toBe(200)
  })

  test("a submission with no rounds, and a round with no bundle, both render cleanly", async ({
    page,
    request,
  }) => {
    const customerEmail = uniqueEmail("e2e-op-round-empty")
    const seeded = await seedSubmission(page, customerEmail, "empty-states")

    // No design round has ever been pushed for this submission.
    const emptyRoundsPage = await request.get(`/requests/${seeded.id}/rounds`, {
      headers: operatorHeaders(DEV_OPERATOR),
    })
    expect(emptyRoundsPage.status()).toBe(200)
    const emptyBody = await emptyRoundsPage.text()
    expect(emptyBody).toContain("No design round has been published for this request yet.")
    expect(emptyBody).not.toContain('data-testid="round-entry"')

    // A round with no mock bundle at all — `mock_bundle` omitted.
    await publishRound(request, seeded.reference, 1, {
      outcome_definition: "A round nobody has attached a mock to yet.",
      decomposition: ["Work that has not produced a mock yet"],
    })

    const roundsPage = await request.get(`/requests/${seeded.id}/rounds`, {
      headers: operatorHeaders(DEV_OPERATOR),
    })
    expect(roundsPage.status()).toBe(200)
    const body = await roundsPage.text()
    expect(body).toContain('data-testid="round-entry"')
    expect(body).not.toContain('data-testid="operator-mock-bundle-link"')

    // Reaching for that round's bundle anyway 404s cleanly, never a 500.
    const bundleRes = await request.get(`/requests/${seeded.id}/rounds/1/mock`, {
      headers: operatorHeaders(DEV_OPERATOR),
    })
    expect(bundleRes.status()).toBe(404)
  })
})
