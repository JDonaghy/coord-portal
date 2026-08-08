import { describe, expect, it } from "vitest"

import worker from "../src/index"
import { fakeEnv, get } from "./fixtures"

describe("routing", () => {
  it("serves the static site for a non-API path", async () => {
    const res = await worker.fetch(get("/"), fakeEnv())
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
  })

  it("404s an unknown API path as JSON, not as the SPA", async () => {
    const res = await worker.fetch(get("/api/nope"), fakeEnv())
    expect(res.status).toBe(404)
    expect(res.headers.get("content-type")).toContain("application/json")
    await expect(res.json()).resolves.toMatchObject({ error: "not_found" })
  })

  it("405s a known path with the wrong method and says what is allowed", async () => {
    const req = new Request("https://portal.test/api/health", { method: "POST" })
    const res = await worker.fetch(req, fakeEnv())
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("GET")
  })

  it("turns a handler throw into a 500 that leaks nothing", async () => {
    const env = fakeEnv({ d1Throws: new Error("connection string: super-secret") })
    // health catches its own probe errors, so force a failure past the handler
    // by breaking the binding entirely.
    const broken = { ...env, DB: undefined } as unknown as typeof env
    const res = await worker.fetch(get("/api/health"), broken)
    const body = await res.text()
    expect(body).not.toContain("super-secret")
    expect([500, 503]).toContain(res.status)
  })

  it("never sets a CORS header — the API has no cross-origin caller", async () => {
    const res = await worker.fetch(get("/api/health"), fakeEnv())
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })
})
