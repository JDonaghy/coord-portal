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
    expect(html).toContain('href="https://portal.example.test/submissions/SUB-HTML01"')
    expect(html).toContain("Review &lt;the&gt; design")
    expect(html).toContain("plain &amp; simple")
    // The escaping is the point, not the shell: neither the customer's own
    // words nor the label may reach the recipient's mail client as markup.
    expect(html).not.toContain("Review <the> design")
    expect(html).not.toContain("plain & simple")
  })

  // ── issue #105: the branded shell ────────────────────────────────────────
  //
  // The defect: a `signoff-ready` send landed in a real recipient's spam folder
  // and was nearly dismissed as spam even after she found it, because nothing
  // about it identified the business she had hired. #83's HTML part was
  // `<p>body</p><p><a>label</a></p>` — linkable, and completely anonymous.

  /** The exact CTA-bearing email the assertions below all render. */
  function brandedHtml(): string {
    const html = composeHtmlBody({
      to: "a@example.test",
      from: "Heuron Technology <notify@mail.heurontech.com>",
      subject: "Design ready for review — Heuron Technology",
      body: 'Hi — I\'ve put together a design for "A rota."\n\n— John, Heuron Technology',
      ctaText: "Review the design",
      ctaHref: "https://portal.example.test/submissions/SUB-BRAND1",
    })
    expect(html, "a CTA-bearing email always has an HTML part").toBeDefined()
    return html as string
  }

  it("composeHtmlBody names Heuron Technology in the HTML part", () => {
    // #105 Acceptance: "A `signoff-ready` email's HTML part visibly identifies
    // 'Heuron Technology'". The wordmark is text — see `BRAND`'s doc for why it
    // may never be an image.
    const html = brandedHtml()
    expect(html).toContain(">Heuron Technology<")
    // And the CTA's unfamiliar destination is tied back to the domain the
    // recipient does know.
    expect(html).toContain("heurontech.com")
  })

  it("composeHtmlBody makes no external network request — no remote image, no font fetch", () => {
    // #105 Acceptance, second half. A blocked-image placeholder where a brand
    // mark should be reads as *more* suspicious than no brand mark, and a
    // remote fetch in a message body is itself a spam signal. Both font stacks
    // must therefore degrade locally rather than be pulled from a CDN.
    const html = brandedHtml()
    expect(html, "no <img> — the wordmark is text").not.toMatch(/<\s*img\b/i)
    expect(html, "no <link> — fonts are never fetched").not.toMatch(/<\s*link\b/i)
    expect(html, "no @import of a remote stylesheet").not.toMatch(/@import/i)
    expect(html, "no <script> in an email, ever").not.toMatch(/<\s*script\b/i)
    // Nothing anywhere in the markup reaches off-host except the CTA itself.
    const urls = html.match(/https?:\/\/[^\s"'<>]+/gi) ?? []
    expect(urls).toEqual(["https://portal.example.test/submissions/SUB-BRAND1"])
  })

  it("composeHtmlBody carries the brand palette inline, not as custom properties", () => {
    // Outlook has never supported `var()` and Gmail strips `<style>` from a
    // forwarded message; a token that resolves to nothing renders as unstyled
    // black-on-white, which is the exact anonymity this change removes.
    const html = brandedHtml()
    expect(html).toContain("#0B3036") // --green, the CTA fill
    expect(html).toContain("#FBF8F6") // --paper, the page behind the card
    expect(html).toContain("#E2DCD8") // --rule, the card border
    expect(html).not.toContain("var(--")
    expect(html).not.toMatch(/<\s*style\b/i)
  })

  it("composeHtmlBody renders the CTA as a filled button, not a bare link", () => {
    const html = brandedHtml()
    const anchor = /<a\b[^>]*>/i.exec(html)?.[0] ?? ""
    expect(anchor).toContain("background:#0B3036")
    expect(anchor).toContain("color:#FFFFFF")
    expect(anchor).toContain("text-decoration:none")
    // Still exactly one destination in the message: the submission.
    expect(html.match(/<a\b/gi)).toHaveLength(1)
  })

  it("composeHtmlBody splits the signature onto its own paragraph", () => {
    // `emailContent`'s bodies close with a blank-line-separated signature.
    // #83's single `<p>${body}</p>` would have collapsed that to a space and
    // run "— John, Heuron Technology" onto the end of the sentence above it.
    const html = brandedHtml()
    expect(html).toContain("<p style=\"margin:0 0 16px;\">— John, Heuron Technology</p>")
    expect(html).not.toContain('for &quot;A rota.&quot; — John')
  })

  it("composeHtmlBody turns a single newline into a break, not a lost line", () => {
    const html = composeHtmlBody({
      to: "a@example.test",
      from: "f@example.test",
      subject: "s",
      body: "line one\nline two",
      ctaHref: "https://portal.example.test/submissions/SUB-BRAND2",
    })
    expect(html).toContain("line one<br />line two")
  })

  it("composeHtmlBody answers 'why am I getting this?' in the body", () => {
    // The question a recipient asks immediately before hitting Report Spam.
    const html = brandedHtml()
    expect(html).toContain("You are receiving this because you asked Heuron Technology")
  })

  it("composeTextBody is untouched by the branded shell — no markup in the text part", () => {
    // `tests/acceptance/ms-3/83-email-link.spec.ts` splits the recorded payload
    // into "looks like markup" and "does not", and requires the full followable
    // URL to appear in a string that does NOT look like markup. A text-only
    // client, and every "view original" reader, still needs that.
    const text = composeTextBody({
      to: "a@example.test",
      from: "f@example.test",
      subject: "s",
      body: 'Hi — I\'ve put together a design for "A rota."\n\n— John, Heuron Technology',
      ctaText: "Review the design",
      ctaHref: "https://portal.example.test/submissions/SUB-BRAND3",
    })
    expect(text).not.toMatch(/<\s*(a|p|div|table|td|br|span|h[1-6])\b/i)
    expect(text).toContain("https://portal.example.test/submissions/SUB-BRAND3")
    expect(text).toContain("— John, Heuron Technology")
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
    // The anchor now carries #105's button styling, so this matches the `href`
    // rather than the whole open tag — the same thing
    // `tests/acceptance/ms-3/83-email-link.spec.ts` matches on.
    expect(sent.html).toMatch(/<a\b[^>]*href="https:\/\/portal\.example\.test\/submissions\/SUB-9"/)
    // The Resend adapter gets the branded shell too, not just the fake: #83's
    // whole reason for composing at this seam.
    expect(sent.html).toContain("Heuron Technology")
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
