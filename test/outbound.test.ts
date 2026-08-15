import { describe, expect, it } from "vitest"
import worker from "../src/index"
import { FakeMailProvider } from "../src/mailProvider"
import { fakeEnv, get } from "./fixtures"

/**
 * Unit coverage for `GET /__outbound` (issue #83, `src/routes/outbound.ts`) —
 * the dev-only read-back of #51's recording fake, which
 * `tests/acceptance/ms-3/83-email-link.spec.ts` depends on to assert the
 * sealed suite's own gap (every CTA assertion this milestone had lands on
 * `GET /outbox`, never on what the drain actually handed the provider).
 *
 * Every address below is invented on the reserved `example.test` TLD —
 * CLAUDE.md rule 1.
 */
describe("GET /__outbound", () => {
  it('404s when MAIL_PROVIDER is not "fake" — never reachable in production', async () => {
    const res = await worker.fetch(get("/__outbound"), fakeEnv())
    expect(res.status).toBe(404)
  })

  it("200s with the fake's recorded payloads when MAIL_PROVIDER=fake", async () => {
    const env = { ...fakeEnv(), MAIL_PROVIDER: "fake" }
    await new FakeMailProvider().send({
      to: "rota-outbound-route@example.test",
      from: "f@example.test",
      subject: "s",
      body: "b",
      ctaText: "Review the design",
      ctaHref: "https://portal.example.test/submissions/SUB-RT01",
    })

    const res = await worker.fetch(get("/__outbound"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { emails: Array<{ to: string; text: string }> }
    const mine = body.emails.filter((e) => e.to === "rota-outbound-route@example.test")
    expect(mine).toHaveLength(1)
    expect(mine[0]?.text).toContain("https://portal.example.test/submissions/SUB-RT01")
  })
})
