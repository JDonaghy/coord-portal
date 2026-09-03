import { describe, expect, it } from "vitest"

import worker from "../src/index"
import { VERSION } from "../src/version"
import { fakeEnv, get } from "./fixtures"

describe("GET /api/health", () => {
  it("reports ok with the schema version when both bindings answer", async () => {
    const res = await worker.fetch(get("/api/health"), fakeEnv())
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      service: "coord-portal",
      version: VERSION,
      deployment: "portal.test",
      checks: {
        d1: { ok: true, detail: "schema 0001" },
        r2: { ok: true },
        intake: { ok: true, lastReceivedAt: null, recentCount: 0 },
      },
    })
  })

  it("503s when D1 is unreachable, and names which probe failed", async () => {
    const res = await worker.fetch(
      get("/api/health"),
      fakeEnv({ d1Throws: new Error("no such table: schema_meta") }),
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { ok: boolean; checks: { d1: { ok: boolean } } }
    expect(body.ok).toBe(false)
    expect(body.checks.d1.ok).toBe(false)
  })

  it("503s when migrations have not been applied", async () => {
    const res = await worker.fetch(get("/api/health"), fakeEnv({ schemaVersion: null }))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { checks: { d1: { detail: string } } }
    expect(body.checks.d1.detail).toContain("migrations not applied")
  })

  it("503s when R2 is unreachable even though D1 is fine", async () => {
    const res = await worker.fetch(
      get("/api/health"),
      fakeEnv({ r2Throws: new Error("bucket not found") }),
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { checks: { d1: { ok: boolean }; r2: { ok: boolean } } }
    expect(body.checks.d1.ok).toBe(true)
    expect(body.checks.r2.ok).toBe(false)
  })

  /**
   * Issue #197 — #160's ops step 4, never done: "add the forward to the
   * health checks. The failure mode is silence, and silence is what a
   * working intake mailbox already looks like." These assert the new
   * `checks.intake` block that closes that gap.
   */
  describe("checks.intake — issue #197", () => {
    it("reports the most recent inbound timestamp and a recent-window count, alongside d1 and r2", async () => {
      const res = await worker.fetch(
        get("/api/health"),
        fakeEnv({ intakeLastReceivedAt: "2026-08-30T12:00:00.000Z", intakeRecentCount: 3 }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        checks: { intake: { ok: boolean; lastReceivedAt: string | null; recentCount: number } }
      }
      expect(body.ok).toBe(true)
      expect(body.checks.intake).toEqual({
        ok: true,
        lastReceivedAt: "2026-08-30T12:00:00.000Z",
        recentCount: 3,
      })
    })

    it("stays ok when no mail has ever been recorded — silence is not, on its own, an outage", async () => {
      // #197's own words: a quiet week is not an outage for a business this
      // size, and a health check that asserts a fixed freshness threshold
      // gets ignored — which reproduces the original failure by a different
      // route. Zero rows, ever, must still be `ok: true` here.
      const res = await worker.fetch(get("/api/health"), fakeEnv())
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        checks: { intake: { ok: boolean; lastReceivedAt: string | null; recentCount: number } }
      }
      expect(body.ok).toBe(true)
      expect(body.checks.intake).toEqual({ ok: true, lastReceivedAt: null, recentCount: 0 })
    })

    it("503s and names the intake probe when its own query fails, independently of d1 and r2", async () => {
      const res = await worker.fetch(
        get("/api/health"),
        fakeEnv({ intakeThrows: new Error("no such table: inbound_emails") }),
      )
      expect(res.status).toBe(503)
      const body = (await res.json()) as {
        ok: boolean
        checks: {
          d1: { ok: boolean }
          r2: { ok: boolean }
          intake: { ok: boolean; detail?: string }
        }
      }
      expect(body.ok).toBe(false)
      expect(body.checks.d1.ok).toBe(true)
      expect(body.checks.r2.ok).toBe(true)
      expect(body.checks.intake.ok).toBe(false)
      expect(body.checks.intake.detail).toContain("inbound_emails")
    })

    it("reveals only counts and a timestamp — never a sender, subject or body", async () => {
      const res = await worker.fetch(
        get("/api/health"),
        fakeEnv({ intakeLastReceivedAt: "2026-08-30T12:00:00.000Z", intakeRecentCount: 1 }),
      )
      const body = (await res.json()) as { checks: { intake: Record<string, unknown> } }
      expect(Object.keys(body.checks.intake).sort()).toEqual(["lastReceivedAt", "ok", "recentCount"])
    })
  })
})
