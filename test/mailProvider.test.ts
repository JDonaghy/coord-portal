import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakeMailProvider, ResendMailProvider, selectMailProvider } from "../src/mailProvider"
import type { Env } from "../src/types"

/**
 * Unit coverage for issue #51's provider seam, built alongside issue #50's
 * drain because nothing else in this repo defines it yet (see `src/mailProvider.ts`'s
 * own module doc). `FakeMailProvider`'s deterministic `mailfail` hook is
 * exercised end to end by the sealed `tests/acceptance/ms-3/50-drain.spec.ts`
 * slice; this file covers the same logic in isolation, plus `ResendMailProvider`'s
 * fail-closed behaviour, which nothing black-box in this repo can reach (no
 * real Resend key is ever configured for a test run).
 *
 * Every address below is invented on the reserved `example.test` TLD — CLAUDE.md
 * rule 1.
 */

function env(overrides: Partial<Env> = {}): Env {
  return overrides as Env
}

describe("FakeMailProvider", () => {
  const provider = new FakeMailProvider()

  it("succeeds for a recipient whose local-part has no mailfail substring", async () => {
    const outcome = await provider.send({
      to: "rota-drain-moves@example.test",
      from: "coord-portal <notify@intake.heurontech.com>",
      subject: "s",
      body: "b",
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.providerMessageId.length).toBeGreaterThan(0)
    }
  })

  it("fails deterministically, every call, for a mailfail local-part", async () => {
    for (const to of [
      "rota-mailfail@example.test",
      "rota-MAILFAIL-giveup@example.test",
      "MailFail@example.test",
    ]) {
      const first = await provider.send({ to, from: "f@example.test", subject: "s", body: "b" })
      const second = await provider.send({ to, from: "f@example.test", subject: "s", body: "b" })
      expect(first.ok, to).toBe(false)
      expect(second.ok, to).toBe(false)
    }
  })

  it("does not match mailfail across the @ boundary", async () => {
    // The substring must be in the local-part; a domain that happens to
    // contain it is not the hook (the contract's own example only ever shows
    // it before the @).
    const outcome = await provider.send({
      to: "rota@mailfail.example.test",
      from: "f@example.test",
      subject: "s",
      body: "b",
    })
    expect(outcome.ok).toBe(true)
  })

  it("returns a fresh providerMessageId on every successful call", async () => {
    const a = await provider.send({ to: "a@example.test", from: "f@example.test", subject: "s", body: "b" })
    const b = await provider.send({ to: "a@example.test", from: "f@example.test", subject: "s", body: "b" })
    expect(a.ok && b.ok && a.providerMessageId !== b.providerMessageId).toBe(true)
  })
})

describe("ResendMailProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("fails closed on an unset key, without calling the network", async () => {
    const provider = new ResendMailProvider(undefined)
    const outcome = await provider.send({ to: "a@example.test", from: "f@example.test", subject: "s", body: "b" })
    expect(outcome).toEqual({ ok: false, error: "RESEND_API_KEY unset" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("records a raw, operator-facing error on a non-OK response", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }))
    const provider = new ResendMailProvider("test-key")
    const outcome = await provider.send({ to: "a@example.test", from: "f@example.test", subject: "s", body: "b" })
    expect(outcome).toEqual({ ok: false, error: "Resend API returned 401" })
  })

  it("fails closed, without throwing, when the network call itself rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))
    const provider = new ResendMailProvider("test-key")
    const outcome = await provider.send({ to: "a@example.test", from: "f@example.test", subject: "s", body: "b" })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain("network down")
  })

  it("succeeds and carries back Resend's own id on a 2xx response", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "resend-abc123" }), { status: 200 }))
    const provider = new ResendMailProvider("test-key")
    const outcome = await provider.send({ to: "a@example.test", from: "f@example.test", subject: "s", body: "b" })
    expect(outcome).toEqual({ ok: true, providerMessageId: "resend-abc123" })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.resend.com/emails")
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer test-key")
  })
})

describe("selectMailProvider", () => {
  it("selects the fake when MAIL_PROVIDER is exactly \"fake\", regardless of RESEND_API_KEY", () => {
    expect(selectMailProvider(env({ MAIL_PROVIDER: "fake" }))).toBeInstanceOf(FakeMailProvider)
    expect(
      selectMailProvider(env({ MAIL_PROVIDER: "fake", RESEND_API_KEY: "real-key" })),
    ).toBeInstanceOf(FakeMailProvider)
  })

  it("selects Resend when MAIL_PROVIDER is unset or anything else", () => {
    expect(selectMailProvider(env())).toBeInstanceOf(ResendMailProvider)
    expect(selectMailProvider(env({ MAIL_PROVIDER: "resend" }))).toBeInstanceOf(ResendMailProvider)
  })
})
