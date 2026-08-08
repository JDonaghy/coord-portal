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
      env: "test",
      checks: { d1: { ok: true, detail: "schema 0001" }, r2: { ok: true } },
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
})
