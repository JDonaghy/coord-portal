import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TURNSTILE_FIELD, publicSitekey, verifySubmission } from "../src/turnstile"
import type { Env } from "../src/types"

/**
 * Unit coverage for the decidable parts of the Turnstile bot gate (issue
 * #32): the dev-fallback config resolution (mirrors `test/operators.test.ts`'
 * coverage of `DEV_OPERATOR_EMAIL`) and the local shape check that makes
 * "malformed token" rejection possible at all against Cloudflare's documented
 * always-pass test secret.
 *
 * `verifySubmission`'s actual `siteverify` round trip — the part that needs a
 * real network call to Cloudflare — is covered black-box by the sealed
 * acceptance slice (`tests/acceptance/ms-2/32-bot-gate-rate-limit.spec.ts`)
 * and this repo's own e2e coverage against `wrangler dev`, per the same
 * "a mocked network call only proves the stub does what I wrote it to do"
 * reasoning `test/rounds.test.ts` gives for D1. Here, `fetch` is stubbed only
 * to prove this module calls (or does NOT call) it at the right times — never
 * to assert what Cloudflare's API itself returns.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

function env(overrides: Partial<Env> = {}): Env {
  return overrides as Env
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://portal.test/start", { headers })
}

/** What Cloudflare's edge adds to every request it forwards. */
const EDGE = { "CF-Ray": "8f0000000000abcd-LHR" }

const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"
/** Comfortably past `MIN_PLAUSIBLE_TOKEN_LENGTH`, all safe characters. */
const PLAUSIBLE_TOKEN = "0." + "a".repeat(200)

describe("publicSitekey", () => {
  it("renders a configured sitekey regardless of edge", () => {
    const configured = env({ TURNSTILE_SITEKEY: "1x00000000000000000000AA" })
    expect(publicSitekey(request(), configured)).toBe("1x00000000000000000000AA")
    expect(publicSitekey(request(EDGE), configured)).toBe("1x00000000000000000000AA")
  })

  it("falls back to the documented always-pass test sitekey away from the edge", () => {
    expect(publicSitekey(request(), env())).toBe("1x00000000000000000000AA")
  })

  it("fails closed to an empty sitekey behind the edge when unset", () => {
    // A deploy that forgot to configure Turnstile still renders `/start`
    // (never a 500) — it just cannot mint a valid submission from it, same
    // trade `src/operators.ts` makes for OPERATOR_EMAILS.
    expect(publicSitekey(request(EDGE), env())).toBe("")
  })
})

describe("verifySubmission", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("rejects a missing or blank token without calling siteverify", async () => {
    for (const token of ["", "   "]) {
      await expect(verifySubmission(request(), env(), token)).resolves.toBe(false)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects an unset secret behind the edge without calling siteverify — fail closed", async () => {
    // "An unset secret must fail closed ... rather than quietly accepting
    // every submission" (issue #32). No secret, no network call, no doubt.
    await expect(
      verifySubmission(request(EDGE), env(), PLAUSIBLE_TOKEN),
    ).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects tokens that cannot plausibly be a real Turnstile response, without calling siteverify", async () => {
    // Measured directly against Cloudflare's real `siteverify` (2026-08-10):
    // the documented always-pass secret returns `success: true` for ANY
    // non-empty response, including every string below — so this local shape
    // check is the only thing that can reject them at all, and it must do so
    // without spending a network call.
    const unverifiable = [
      "not-a-turnstile-token",
      DUMMY_TOKEN.slice(0, 8),
      "XXXX.DUMMY.TOKEN",
      "0.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      `X.${"A".repeat(4096)}.X`,
      `${DUMMY_TOKEN}\n${DUMMY_TOKEN}`,
    ]
    for (const token of unverifiable) {
      await expect(verifySubmission(request(), env(), token)).resolves.toBe(false)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("accepts the literal dummy token the test widget mints, as a special case", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))
    await expect(verifySubmission(request(), env(), DUMMY_TOKEN)).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("calls siteverify for anything that looks like a real token, and trusts its answer", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))
    await expect(verifySubmission(request(), env(), PLAUSIBLE_TOKEN)).resolves.toBe(true)

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 200 }))
    await expect(verifySubmission(request(), env(), PLAUSIBLE_TOKEN)).resolves.toBe(false)
  })

  it("uses the configured secret when set, even behind the edge", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))
    await verifySubmission(
      request(EDGE),
      env({ TURNSTILE_SECRET: "real-secret-value" }),
      PLAUSIBLE_TOKEN,
    )
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(init.body)).toContain("secret=real-secret-value")
  })

  it("fails closed on a non-OK response from siteverify", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 503 }))
    await expect(verifySubmission(request(), env(), PLAUSIBLE_TOKEN)).resolves.toBe(false)
  })

  it("fails closed when siteverify is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))
    await expect(verifySubmission(request(), env(), PLAUSIBLE_TOKEN)).resolves.toBe(false)
  })

  it("forwards the caller's CF-Connecting-IP as remoteip when present", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))
    await verifySubmission(
      request({ "CF-Connecting-IP": "203.0.113.9" }),
      env(),
      PLAUSIBLE_TOKEN,
    )
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(init.body)).toContain("remoteip=203.0.113.9")
  })
})

describe("TURNSTILE_FIELD", () => {
  it("is Turnstile's own documented hidden-input name", () => {
    expect(TURNSTILE_FIELD).toBe("cf-turnstile-response")
  })
})
