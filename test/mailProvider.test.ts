import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  composeHtmlBody,
  composeTextBody,
  FakeMailProvider,
  recordedFakeEmails,
  ResendMailProvider,
  selectMailProvider,
} from "../src/mailProvider"
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

describe("composeTextBody / composeHtmlBody (issue #83)", () => {
  it("composeTextBody is the untouched body when there is no CTA", () => {
    expect(composeTextBody({ to: "a@example.test", from: "f@example.test", subject: "s", body: "plain" })).toBe(
      "plain",
    )
  })

  it("composeTextBody appends the CTA label and the full absolute URL, visibly, when present", () => {
    const text = composeTextBody({
      to: "a@example.test",
      from: "f@example.test",
      subject: "s",
      body: "plain",
      ctaText: "Review the design",
      ctaHref: "https://portal.example.test/submissions/SUB-TEXT01",
    })
    expect(text).toContain("plain")
    expect(text).toContain("Review the design")
    expect(text).toContain("https://portal.example.test/submissions/SUB-TEXT01")
  })

  it("composeTextBody falls back to a generic label when ctaText is absent but ctaHref is present", () => {
    const text = composeTextBody({
      to: "a@example.test",
      from: "f@example.test",
      subject: "s",
      body: "plain",
      ctaHref: "https://portal.example.test/submissions/SUB-TEXT02",
    })
    expect(text).toContain("https://portal.example.test/submissions/SUB-TEXT02")
  })

  it("composeHtmlBody is undefined with no CTA — no HTML alternative for an email with nothing to link", () => {
    expect(
      composeHtmlBody({ to: "a@example.test", from: "f@example.test", subject: "s", body: "plain" }),
    ).toBeUndefined()
  })

  it("composeHtmlBody links the CTA href in an anchor, with every part HTML-escaped", () => {
    const html = composeHtmlBody({
      to: "a@example.test",
      from: "f@example.test",
      subject: "s",
      body: "plain & simple",
      ctaText: "Review <the> design",
      ctaHref: "https://portal.example.test/submissions/SUB-HTML01",
    })
    expect(html).toContain('<a href="https://portal.example.test/submissions/SUB-HTML01">')
    expect(html).toContain("Review &lt;the&gt; design")
    expect(html).toContain("plain &amp; simple")
  })
})

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

describe("FakeMailProvider recording (issue #51's own scope: \"records the payloads it was handed\", exercised for #83)", () => {
  // `recordedFakeEmails()` is a module-level singleton (see `src/mailProvider.ts`'s
  // own doc on why) that accumulates across every test in this file — each test
  // below uses its own unique recipient, the same isolation strategy
  // `tests/acceptance/ms-3/83-email-link.spec.ts` uses against the real Worker,
  // so accumulation across tests never produces a false positive or negative.
  const provider = new FakeMailProvider()

  it("records what was handed to it, readable back via recordedFakeEmails()", async () => {
    await provider.send({
      to: "rota-recorded@example.test",
      from: "f@example.test",
      subject: "s",
      body: "b",
      ctaText: "Review the design",
      ctaHref: "https://portal.example.test/submissions/SUB-REC01",
    })

    const mine = recordedFakeEmails().filter((e) => e.to === "rota-recorded@example.test")
    expect(mine).toHaveLength(1)
    expect(mine[0]?.text).toContain("https://portal.example.test/submissions/SUB-REC01")
    expect(mine[0]?.html).toContain('href="https://portal.example.test/submissions/SUB-REC01"')
  })

  it("records a send with no CTA using the unmodified body, and no html at all", async () => {
    await provider.send({
      to: "rota-nocta@example.test",
      from: "f@example.test",
      subject: "s",
      body: "plain body",
    })

    const mine = recordedFakeEmails().filter((e) => e.to === "rota-nocta@example.test")
    expect(mine).toHaveLength(1)
    expect(mine[0]?.text).toBe("plain body")
    expect(mine[0]?.html).toBeUndefined()
  })

  it("records even a deterministically-failed mailfail send — issue #51 records payloads, not outcomes", async () => {
    await provider.send({
      to: "rota-mailfail-recorded@example.test",
      from: "f@example.test",
      subject: "s",
      body: "b",
    })

    const mine = recordedFakeEmails().filter((e) => e.to === "rota-mailfail-recorded@example.test")
    expect(mine).toHaveLength(1)
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

  // Issue #52: the `From` domain is send-only, so `Reply-To` is the entire
  // reply path. These two cover the seam in both directions — nothing else in
  // this repo can, since no black-box surface sees a real Resend request.
  it("sends reply_to when a reply address is configured", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "resend-r1" }), { status: 200 }))
    const provider = new ResendMailProvider("test-key")
    await provider.send({
      to: "a@example.test",
      from: "f@example.test",
      subject: "s",
      body: "b",
      replyTo: "replies@example.test",
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ reply_to: "replies@example.test" })
  })

  it("omits reply_to entirely when no reply address is configured", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "resend-r2" }), { status: 200 }))
    const provider = new ResendMailProvider("test-key")
    await provider.send({ to: "a@example.test", from: "f@example.test", subject: "s", body: "b" })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // Absent, not null and not "": Resend writes a header for a present-but-
    // empty value, and a malformed `Reply-To` can leave a customer with no
    // reply target at all — worse than the header simply not being there.
    expect(JSON.parse(init.body as string)).not.toHaveProperty("reply_to")
  })

  // Issue #83: the CTA has to reach "both the fake and the Resend
  // implementation" — this covers the Resend half, which previously posted
  // `text` only and had nowhere for a link to be clickable even once carried.
  it("sends the composed text (with a visible CTA link) and an html body when a CTA is present", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "resend-cta1" }), { status: 200 }))
    const provider = new ResendMailProvider("test-key")
    await provider.send({
      to: "a@example.test",
      from: "f@example.test",
      subject: "s",
      body: "b",
      ctaText: "Review the design",
      ctaHref: "https://portal.example.test/submissions/SUB-9",
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const sent = JSON.parse(init.body as string) as { text: string; html: string }
    expect(sent.text).toContain("https://portal.example.test/submissions/SUB-9")
    expect(sent.html).toContain('<a href="https://portal.example.test/submissions/SUB-9">')
  })

  it("omits html entirely, and sends the unmodified body as text, when no CTA is present", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "resend-nocta" }), { status: 200 }))
    const provider = new ResendMailProvider("test-key")
    await provider.send({ to: "a@example.test", from: "f@example.test", subject: "s", body: "b" })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const sent = JSON.parse(init.body as string) as { text: string }
    expect(sent.text).toBe("b")
    expect(sent).not.toHaveProperty("html")
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
