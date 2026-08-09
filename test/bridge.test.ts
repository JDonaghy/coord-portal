import { describe, expect, it } from "vitest"

import { isBridgeAuthorized } from "../src/bridge/auth"
import { decodeCursor, encodeCursor } from "../src/bridge/cursor"
import { parsePullLimit } from "../src/bridge/events"
import {
  DAEMON_STALE_AFTER_MS,
  daemonFreshness,
  normaliseTimestamp,
} from "../src/bridge/heartbeat"
import {
  COORD_OWNED_FIELDS,
  PORTAL_OWNED_FIELDS,
  ownerOf,
} from "../src/bridge/ownership"
import worker from "../src/index"
import type { Env } from "../src/types"
import { fakeEnv } from "./fixtures"

/**
 * Unit coverage for the sync bridge's decidable parts — the gate, the cursor
 * codec, the sole-writer table and the staleness clock.
 *
 * The parts that need a real database (pull ordering, push idempotency,
 * whole-update atomicity) are covered black-box in `e2e/bridge.spec.ts` against
 * `wrangler dev` with real D1, because a mocked D1 would be asserting that my
 * stub does what I wrote it to do.
 *
 * Every credential below is invented — see CLAUDE.md rule 1.
 */

const CLIENT_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90.access"
const CLIENT_SECRET = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"

const TOKEN = {
  "CF-Access-Client-Id": CLIENT_ID,
  "CF-Access-Client-Secret": CLIENT_SECRET,
}

function envWithToken(): Env {
  return {
    ...fakeEnv(),
    BRIDGE_CLIENT_ID: CLIENT_ID,
    BRIDGE_CLIENT_SECRET: CLIENT_SECRET,
  }
}

/**
 * A request as it arrives in production: through Cloudflare's edge, which
 * stamps `CF-Ray`. That header — not the hostname — is what tells this Worker
 * an Access application had a chance to look at the request first; `wrangler
 * dev` serves the custom domain locally, so the hostname says "production" from
 * a laptop. See `src/deployment.ts`.
 */
function bridgeRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://intake.heurontech.com${path}`, {
    method: "GET",
    headers: { "CF-Ray": "9a1b2c3d4e5f6a7b-LHR", ...headers },
  })
}

/** The same request under `wrangler dev`: no edge, so no `CF-Ray`. */
function localBridgeRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://intake.heurontech.com${path}`, { method: "GET", headers })
}

describe("bridge service-token gate", () => {
  it("refuses a request with no credential at all", () => {
    expect(isBridgeAuthorized(bridgeRequest("/api/bridge/pull"), envWithToken())).toBe(false)
  })

  it("refuses half a credential", () => {
    const idOnly = bridgeRequest("/api/bridge/pull", { "CF-Access-Client-Id": CLIENT_ID })
    const secretOnly = bridgeRequest("/api/bridge/pull", {
      "CF-Access-Client-Secret": CLIENT_SECRET,
    })
    expect(isBridgeAuthorized(idOnly, envWithToken())).toBe(false)
    expect(isBridgeAuthorized(secretOnly, envWithToken())).toBe(false)
  })

  it("refuses empty header values, which are missing values wearing a hat", () => {
    const empty = bridgeRequest("/api/bridge/pull", {
      "CF-Access-Client-Id": "   ",
      "CF-Access-Client-Secret": "",
    })
    expect(isBridgeAuthorized(empty, envWithToken())).toBe(false)
  })

  it("refuses a signed-in human — /api/bridge is not a general Access bypass", () => {
    const human = bridgeRequest("/api/bridge/pull", {
      "Cf-Access-Authenticated-User-Email": "customer@example.test",
    })
    expect(isBridgeAuthorized(human, envWithToken())).toBe(false)
  })

  it("accepts the configured pair and refuses a well-formed wrong one", () => {
    expect(isBridgeAuthorized(bridgeRequest("/api/bridge/pull", TOKEN), envWithToken())).toBe(
      true,
    )

    const wrong = bridgeRequest("/api/bridge/pull", {
      "CF-Access-Client-Id": CLIENT_ID,
      "CF-Access-Client-Secret": `${CLIENT_SECRET.slice(0, -1)}1`,
    })
    expect(isBridgeAuthorized(wrong, envWithToken())).toBe(false)
  })

  it("fails CLOSED behind the edge when no credential is configured", () => {
    // A production deploy that forgets `wrangler secret put` must answer
    // nobody, not everybody. Access is still in front of it in reality; this is
    // the layer underneath that assumption.
    expect(isBridgeAuthorized(bridgeRequest("/api/bridge/pull", TOKEN), fakeEnv())).toBe(false)
  })

  it("honours a well-formed pair off the edge, where there is no Access to ask", () => {
    expect(isBridgeAuthorized(localBridgeRequest("/api/bridge/pull", TOKEN), fakeEnv())).toBe(
      true,
    )

    const half = localBridgeRequest("/api/bridge/pull", {
      "CF-Access-Client-Id": CLIENT_ID,
    })
    expect(isBridgeAuthorized(half, fakeEnv())).toBe(false)
  })

  it("cannot be relaxed by a client — forging CF-Ray only makes it stricter", () => {
    // The relaxation keys off the *absence* of a header the edge always sets.
    // A caller who adds one lands in the strict branch, which is the direction
    // that costs them.
    const forged = localBridgeRequest("/api/bridge/pull", {
      ...TOKEN,
      "CF-Ray": "deadbeefdeadbeef-XXX",
    })
    expect(isBridgeAuthorized(forged, fakeEnv())).toBe(false)
    expect(isBridgeAuthorized(forged, envWithToken())).toBe(true)
  })

  it("does not decide on the hostname, which wrangler dev rewrites", () => {
    // Measured: a local request to 127.0.0.1:8788 reaches the Worker as
    // http://intake.heurontech.com/… . A hostname check would have locked the
    // whole local suite out of its own bridge.
    const local = new Request("http://intake.heurontech.com/api/bridge/pull", {
      headers: TOKEN,
    })
    expect(isBridgeAuthorized(local, fakeEnv())).toBe(true)
  })
})

describe("the bridge routes behind the gate", () => {
  const routes: Array<[string, string]> = [
    ["GET", "/api/bridge/pull"],
    ["POST", "/api/bridge/push"],
    ["POST", "/api/bridge/heartbeat"],
  ]

  it("401s every route with no credential, and says nothing about why", async () => {
    const bodies: string[] = []
    for (const [method, path] of routes) {
      const res = await worker.fetch(
        new Request(`https://intake.heurontech.com${path}`, { method }),
        envWithToken(),
      )
      expect(res.status, `${method} ${path}`).toBe(401)
      bodies.push(await res.text())
    }

    // Indistinguishable failures, or the 401 is a probe oracle.
    expect(new Set(bodies).size).toBe(1)
    expect(bodies[0]).toBe("")
  })

  it("401s an unknown path under /api/bridge rather than confirming it is unknown", async () => {
    const res = await worker.fetch(
      new Request("https://intake.heurontech.com/api/bridge/subscribe", { method: "POST" }),
      envWithToken(),
    )
    expect(res.status).toBe(401)
  })

  it("has no inbound registration path even for a credentialled caller", async () => {
    // CLAUDE.md rule 2: no webhook, no callback URL, no push endpoint for the
    // daemon to register — not even behind a shared secret.
    for (const path of [
      "/api/bridge/subscribe",
      "/api/bridge/webhook",
      "/api/bridge/register",
      "/api/bridge/callback",
      "/api/bridge/notify",
    ]) {
      const res = await worker.fetch(
        new Request(`https://intake.heurontech.com${path}`, {
          method: "POST",
          headers: TOKEN,
          body: JSON.stringify({ url: "https://callback.example.test/hook" }),
        }),
        envWithToken(),
      )
      expect(res.status, path).toBe(404)
    }
  })

  it("405s a bridge route reached with the wrong method, once authorised", async () => {
    const res = await worker.fetch(
      new Request("https://intake.heurontech.com/api/bridge/pull", {
        method: "POST",
        headers: TOKEN,
      }),
      envWithToken(),
    )
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("GET")
  })

  it("leaves the rest of the API alone", async () => {
    // The gate covers the /api/bridge prefix and nothing else — /api/health is
    // deliberately unauthenticated and must stay that way.
    const res = await worker.fetch(
      new Request("https://intake.heurontech.com/api/health"),
      envWithToken(),
    )
    expect(res.status).toBe(200)
  })
})

describe("the pull cursor", () => {
  it("round-trips a revision", () => {
    for (const revision of [0, 1, 41, 999_999]) {
      expect(decodeCursor(encodeCursor(revision))).toBe(revision)
    }
  })

  it("is opaque — the revision is not readable off the wire form", () => {
    const cursor = encodeCursor(41)
    expect(cursor).not.toContain("41")
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("refuses a cursor this portal did not issue", () => {
    for (const bogus of ["", "41", "not a cursor", "!!!!", btoa("v9:41"), btoa("v1:-3")]) {
      expect(decodeCursor(bogus), bogus).toBeNull()
    }
  })
})

describe("the pull limit", () => {
  it("defaults to 50 when absent or unreadable", () => {
    expect(parsePullLimit(null)).toBe(50)
    expect(parsePullLimit("")).toBe(50)
    expect(parsePullLimit("fifty")).toBe(50)
  })

  it("clamps into the contract's 1–200", () => {
    expect(parsePullLimit("1")).toBe(1)
    expect(parsePullLimit("200")).toBe(200)
    expect(parsePullLimit("0")).toBe(1)
    expect(parsePullLimit("-5")).toBe(1)
    expect(parsePullLimit("5000")).toBe(200)
    expect(parsePullLimit("7.9")).toBe(7)
  })
})

describe("the sole-writer table", () => {
  it("assigns every pinned field to exactly one side", () => {
    for (const field of PORTAL_OWNED_FIELDS) expect(ownerOf(field), field).toBe("portal")
    for (const field of COORD_OWNED_FIELDS) expect(ownerOf(field), field).toBe("coord")
  })

  it("shares nothing between the two sides — a co-written field is a split-brain", () => {
    const overlap = PORTAL_OWNED_FIELDS.filter((field) =>
      (COORD_OWNED_FIELDS as readonly string[]).includes(field),
    )
    expect(overlap).toEqual([])
  })

  it("treats a field nobody claimed as unknown rather than assuming it is safe", () => {
    expect(ownerOf("priority")).toBe("unknown")
    expect(ownerOf("Status")).toBe("unknown")
    expect(ownerOf("__proto__")).toBe("unknown")
  })
})

describe("daemon last-seen", () => {
  it("accepts an ISO-8601 instant and normalises it to UTC", () => {
    expect(normaliseTimestamp("2026-08-08T19:04:11Z")).toBe("2026-08-08T19:04:11.000Z")
    expect(normaliseTimestamp("2026-08-08T20:04:11+01:00")).toBe("2026-08-08T19:04:11.000Z")
  })

  it("refuses anything that is not a moment in time", () => {
    for (const bogus of [undefined, null, 1_754_679_851, "", "yesterday", "2026-08-08", "2026-08-08T19:04:11"]) {
      expect(normaliseTimestamp(bogus), String(bogus)).toBeNull()
    }
  })

  it("distinguishes never-heard-from from stopped-answering", () => {
    const now = new Date("2026-08-08T19:00:00Z")
    expect(daemonFreshness(null, now)).toBe("never")

    const justNow = new Date(now.getTime() - 1_000).toISOString()
    expect(daemonFreshness({ at: justNow, receivedAt: justNow }, now)).toBe("fresh")

    const ages = new Date(now.getTime() - DAEMON_STALE_AFTER_MS - 1_000).toISOString()
    expect(daemonFreshness({ at: ages, receivedAt: ages }, now)).toBe("stale")
  })

  it("judges freshness on when we received the beat, not on the daemon's clock", () => {
    const now = new Date("2026-08-08T19:00:00Z")
    const ages = new Date(now.getTime() - DAEMON_STALE_AFTER_MS - 1_000).toISOString()
    // A daemon claiming to be from the future does not get to be fresh.
    expect(daemonFreshness({ at: "2400-01-01T00:00:00.000Z", receivedAt: ages }, now)).toBe(
      "stale",
    )
  })
})
