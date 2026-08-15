import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { drainOutbox, processRow, type QueuedRow } from "../src/drain"
import type { MailProvider, OutboundEmail } from "../src/mailProvider"
import type { Env } from "../src/types"

/**
 * Unit coverage for issue #50's drain — the claiming compare-and-swap plus
 * lease ("the thing to get right") and the retry/give-up arc, against a
 * minimal in-memory fake of the exact D1 statements `src/drain.ts` issues.
 * The real Worker behaviour — actually invoked through `GET /__scheduled` —
 * is the sealed acceptance slice's job (`tests/acceptance/ms-3/50-drain.spec.ts`);
 * this file exists so the claim race and the attempt bookkeeping can be
 * asserted in milliseconds, and so a future change to either can fail fast in
 * `npm test` rather than only in the (much slower) acceptance run.
 *
 * A fix-round review of this file's earlier version pointed out that the
 * "two concurrent claims" test below only exercises two invocations racing
 * on an *identical stale snapshot* — the case the `attempts` CAS alone
 * already handled — and does not exercise the *staggered* overlap (a second,
 * independent invocation's batch SELECT landing after the first invocation's
 * claim has already committed but before its `provider.send()` resolves).
 * `"a row mid-send under a live claim is excluded from a second invocation's
 * candidate batch"` below is the test that closes that gap, added alongside
 * `claimed_at`/`CLAIM_LEASE_MS` (`migrations/0011_outbox_claim_lease.sql`,
 * `src/drain.ts`).
 *
 * Every address below is invented on the reserved `example.test` TLD —
 * CLAUDE.md rule 1.
 */

interface StoredRow {
  id: string
  to_email: string
  from_email: string
  subject: string
  body: string
  cta_text: string
  cta_href: string
  attempts: number
  status: string
  last_error: string | null
  sent_at: string | null
  provider_message_id: string | null
  queued_at: string
  claimed_at: string | null
}

function seedRow(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    id: overrides.id ?? "outbox-1",
    to_email: overrides.to_email ?? "rota-drain@example.test",
    from_email: "coord-portal <notify@intake.heurontech.com>",
    subject: "Your design is ready for sign-off",
    body: "We've put together a design. Take a look.",
    cta_text: "Review the design",
    cta_href: "/submissions/SUB-DRAIN01",
    attempts: 0,
    status: "queued",
    last_error: null,
    sent_at: null,
    provider_message_id: null,
    queued_at: "2026-08-11T00:00:00.000Z",
    claimed_at: null,
    ...overrides,
  }
}

/**
 * A fake `Env["DB"]` that understands exactly the handful of prepared
 * statements `src/drain.ts` issues, and nothing else — a mismatch throws
 * loudly (`unrecognized ...`) rather than silently no-op'ing, so a query this
 * file has not kept in step with fails the test that exercises it instead of
 * passing for the wrong reason.
 */
function fakeDrainDB(rows: StoredRow[]) {
  const store = new Map(rows.map((row) => [row.id, { ...row }]))
  const norm = (sql: string) => sql.replace(/\s+/g, " ").trim()

  const DB = {
    prepare(sql: string) {
      const statement = norm(sql)
      return {
        bind(...args: unknown[]) {
          return {
            async all<T>() {
              if (statement.startsWith("SELECT id, to_email")) {
                const [leaseThreshold] = args as [string]
                const results = [...store.values()]
                  .filter(
                    (row) =>
                      row.status === "queued" &&
                      (row.claimed_at === null || row.claimed_at <= leaseThreshold),
                  )
                  .sort(
                    (a, b) =>
                      a.queued_at.localeCompare(b.queued_at) || a.id.localeCompare(b.id),
                  )
                return { results: results as unknown as T[] }
              }
              throw new Error(`fakeDrainDB: unrecognized SELECT: ${statement}`)
            },
            async run() {
              if (statement.startsWith("UPDATE outbox SET attempts = attempts + 1")) {
                const [claimedAt, id, expectedAttempts, leaseThreshold] = args as [
                  string,
                  string,
                  number,
                  string,
                ]
                const row = store.get(id)
                const leaseIsLive = !!row && row.claimed_at !== null && row.claimed_at > leaseThreshold
                const won =
                  !!row && row.status === "queued" && row.attempts === expectedAttempts && !leaseIsLive
                if (won && row) {
                  row.attempts += 1
                  row.claimed_at = claimedAt
                }
                return { meta: { changes: won ? 1 : 0 } }
              }
              if (statement.startsWith("UPDATE outbox SET status = 'sent'")) {
                const [sentAt, providerMessageId, id] = args as [string, string, string]
                const row = store.get(id)
                const won = !!row && row.status === "queued"
                if (won && row) {
                  row.status = "sent"
                  row.sent_at = sentAt
                  row.provider_message_id = providerMessageId
                  row.last_error = null
                  row.claimed_at = null
                }
                return { meta: { changes: won ? 1 : 0 } }
              }
              if (statement.startsWith("UPDATE outbox SET status = 'failed'")) {
                const [lastError, id] = args as [string, string]
                const row = store.get(id)
                const won = !!row && row.status === "queued"
                if (won && row) {
                  row.status = "failed"
                  row.last_error = lastError
                  row.claimed_at = null
                }
                return { meta: { changes: won ? 1 : 0 } }
              }
              if (statement.startsWith("UPDATE outbox SET last_error = ?")) {
                const [lastError, id] = args as [string, string]
                const row = store.get(id)
                const won = !!row && row.status === "queued"
                if (won && row) {
                  row.last_error = lastError
                  row.claimed_at = null
                }
                return { meta: { changes: won ? 1 : 0 } }
              }
              throw new Error(`fakeDrainDB: unrecognized UPDATE: ${statement}`)
            },
          }
        },
      }
    },
  }

  return { DB, store }
}

function queuedRowFrom(stored: StoredRow): QueuedRow {
  return {
    id: stored.id,
    to_email: stored.to_email,
    from_email: stored.from_email,
    subject: stored.subject,
    body: stored.body,
    cta_text: stored.cta_text,
    cta_href: stored.cta_href,
    attempts: stored.attempts,
  }
}

/**
 * `processRow` (#83) logs a `console.warn` on every send made with
 * `PUBLIC_BASE_URL` unset or unusable — deliberately, so the gap stays
 * visible to an operator (see `src/drain.ts`'s `resolveCtaHref`). Every
 * existing test in this file predates #83 and does not set the var, so
 * without this it would spam every run's output; silenced globally here and
 * asserted on directly only where that warning is the point of the test.
 */
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("processRow — the claim", () => {
  it("two concurrent claims of the same stale attempts snapshot: exactly one send", async () => {
    const seeded = seedRow()
    const { DB, store } = fakeDrainDB([seeded])
    const env = { DB } as unknown as Env

    let sendCalls = 0
    const provider: MailProvider = {
      async send() {
        sendCalls++
        return { ok: true, providerMessageId: "fake-msg-1" }
      },
    }

    const row = queuedRowFrom(seeded)
    // Both calls observed the row before either claimed it — the exact shape
    // of #50's "two overlapping invocations" scenario, modelled at the
    // function level rather than through two overlapping HTTP requests.
    await Promise.all([processRow(env, provider, row), processRow(env, provider, row)])

    expect(sendCalls, "the provider must be called at most once for one send decision").toBe(1)
    const final = store.get("outbox-1")
    expect(final?.status).toBe("sent")
    expect(final?.attempts, "the claim increments attempts exactly once, not twice").toBe(1)
  })

  it("a claim against a stale attempts value loses and does not call the provider", async () => {
    const seeded = seedRow({ attempts: 3 })
    const { DB, store } = fakeDrainDB([seeded])
    const env = { DB } as unknown as Env

    let sendCalls = 0
    const provider: MailProvider = {
      async send() {
        sendCalls++
        return { ok: true, providerMessageId: "fake-msg-1" }
      },
    }

    // This caller's snapshot (attempts: 0) is already stale — some other
    // invocation moved the row to attempts: 3 since this caller's SELECT.
    await processRow(env, provider, { ...queuedRowFrom(seeded), attempts: 0 })

    expect(sendCalls, "a lost claim must never reach the provider").toBe(0)
    expect(store.get("outbox-1")?.attempts, "a lost claim must not perturb the row").toBe(3)
    expect(store.get("outbox-1")?.status).toBe("queued")
  })

  it("a row mid-send under a live claim is excluded from a second invocation's candidate batch", async () => {
    // The staggered-overlap scenario a fix-round review traced concretely:
    // invocation A's claim commits (attempts 0→1, `claimed_at` stamped) and
    // it is now awaiting `provider.send()`. Before that resolves, invocation
    // B runs its own independent, fresh batch SELECT (`drainOutbox`, not
    // `processRow` called with A's already-stale snapshot). The `attempts`
    // CAS alone cannot stop B here — B's SELECT would legitimately observe
    // `attempts = 1` and win its own CAS against it. `claimed_at` must keep B
    // from ever seeing this row as a candidate in the first place.
    const seeded = seedRow()
    const { DB, store } = fakeDrainDB([seeded])
    const env = { DB, MAIL_PROVIDER: "fake" } as unknown as Env

    let releaseSend: (() => void) | undefined
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    let sendCalls = 0
    const slowProvider: MailProvider = {
      async send() {
        sendCalls++
        await sendGate
        return { ok: true, providerMessageId: "fake-msg-slow" }
      },
    }

    // Invocation A: claims the row (this commits synchronously inside the
    // fake before the first real await) and blocks on `provider.send()`.
    const invocationA = processRow(env, slowProvider, queuedRowFrom(seeded))

    // Invocation B: an entirely independent, fresh `drainOutbox` pass — the
    // scenario's whole point is that B's SELECT is not handed A's stale
    // snapshot, it runs its own.
    await drainOutbox(env)

    expect(
      sendCalls,
      "B's own drain pass must not have called the provider for a row A already has a live claim on",
    ).toBe(1)
    expect(store.get("outbox-1")?.status, "still mid-send, not yet resolved").toBe("queued")
    expect(store.get("outbox-1")?.attempts, "only A's claim moved this").toBe(1)

    releaseSend?.()
    await invocationA

    expect(store.get("outbox-1")?.status).toBe("sent")
    expect(sendCalls, "the provider is still only ever called once for this row").toBe(1)
  })

  it("a first-try success is sent, with a delivery time and provider id, attempts = 1", async () => {
    const seeded = seedRow()
    const { DB, store } = fakeDrainDB([seeded])
    const env = { DB } as unknown as Env
    const provider: MailProvider = {
      async send() {
        return { ok: true, providerMessageId: "fake-msg-42" }
      },
    }

    await processRow(env, provider, queuedRowFrom(seeded))

    const final = store.get("outbox-1")
    expect(final?.status).toBe("sent")
    expect(final?.attempts).toBe(1)
    expect(final?.sent_at).not.toBeNull()
    expect(final?.provider_message_id).toBe("fake-msg-42")
    expect(final?.last_error).toBeNull()
  })

  it("one failure is a retry: attempts increments, status stays queued, last_error records the raw failure", async () => {
    const seeded = seedRow()
    const { DB, store } = fakeDrainDB([seeded])
    const env = { DB } as unknown as Env
    const provider: MailProvider = {
      async send() {
        return { ok: false, error: "the fake mail provider deterministically rejects this address" }
      },
    }

    await processRow(env, provider, queuedRowFrom(seeded))

    const final = store.get("outbox-1")
    expect(final?.status, "one failure is not a give-up").toBe("queued")
    expect(final?.attempts).toBe(1)
    expect(final?.provider_message_id).toBeNull()
    expect(final?.sent_at).toBeNull()
    expect(final?.last_error).toBe("the fake mail provider deterministically rejects this address")
    expect(final?.claimed_at, "a retry clears its claim so the very next tick can re-claim it").toBeNull()
  })

  it("a success after one or more prior failures clears the stale last_error, not just status", async () => {
    // Non-blocking finding from the fix-round review: a row that fails once
    // (or more) and then succeeds must not end up `status = 'sent'` with a
    // stale `last_error` still sitting in the DB — a latent trap for a future
    // `/deliveries` operator view (#55) or a direct D1 lookup.
    const seeded = seedRow({ attempts: 2, last_error: "Resend API returned 500" })
    const { DB, store } = fakeDrainDB([seeded])
    const env = { DB } as unknown as Env
    const provider: MailProvider = {
      async send() {
        return { ok: true, providerMessageId: "fake-msg-recovered" }
      },
    }

    await processRow(env, provider, queuedRowFrom(seeded))

    const final = store.get("outbox-1")
    expect(final?.status).toBe("sent")
    expect(final?.last_error, "success must clear a stale last_error from an earlier retry").toBeNull()
  })

  it("gives up after the 5th failing attempt, and only then", async () => {
    const provider: MailProvider = {
      async send() {
        return { ok: false, error: "permanent failure" }
      },
    }

    // Attempts 1-4: five separate rows, one per already-accumulated attempts
    // count, each modelling one more cron tick against the same row.
    for (const attemptsBefore of [0, 1, 2, 3]) {
      const seeded = seedRow({ attempts: attemptsBefore })
      const { DB, store } = fakeDrainDB([seeded])
      const env = { DB } as unknown as Env
      await processRow(env, provider, queuedRowFrom(seeded))
      const final = store.get("outbox-1")
      expect(final?.status, `attempt ${attemptsBefore + 1} of 5 must not give up yet`).toBe(
        "queued",
      )
      expect(final?.attempts).toBe(attemptsBefore + 1)
    }

    // The 5th attempt (starting from attempts = 4) exhausts the budget.
    const seeded = seedRow({ attempts: 4 })
    const { DB, store } = fakeDrainDB([seeded])
    const env = { DB } as unknown as Env
    await processRow(env, provider, queuedRowFrom(seeded))
    const final = store.get("outbox-1")
    expect(final?.status, "the 5th failure gives up").toBe("failed")
    expect(final?.attempts).toBe(5)
    expect(final?.last_error).toBe("permanent failure")
  })

  it("a row no longer queued by the time of the claim is left alone", async () => {
    const seeded = seedRow({ status: "sent", sent_at: "2026-08-11T00:00:05.000Z" })
    const { DB, store } = fakeDrainDB([seeded])
    const env = { DB } as unknown as Env
    let sendCalls = 0
    const provider: MailProvider = {
      async send() {
        sendCalls++
        return { ok: true, providerMessageId: "should-not-happen" }
      },
    }

    await processRow(env, provider, queuedRowFrom(seeded))

    expect(sendCalls, "sent is terminal — the claim must not re-fire the provider").toBe(0)
    expect(store.get("outbox-1")?.status).toBe("sent")
  })

  it("a claim whose invocation never cleared it (e.g. evicted mid-send) self-heals once its lease expires", async () => {
    // The fallback path the module doc calls out: `claimed_at` should not be
    // able to strand a row forever if the invocation that set it never got to
    // run its own cleanup. Advance the clock well past `CLAIM_LEASE_MS`
    // (module doc: chosen short relative to the 5-minute Cron Trigger cadence)
    // and confirm a fresh invocation can claim the row again.
    vi.useFakeTimers()
    try {
      const abandonedClaimTime = new Date().toISOString()
      const seeded = seedRow({ attempts: 1, claimed_at: abandonedClaimTime })
      const { DB, store } = fakeDrainDB([seeded])
      const env = { DB } as unknown as Env

      let sendCalls = 0
      const provider: MailProvider = {
        async send() {
          sendCalls++
          return { ok: true, providerMessageId: "fake-msg-healed" }
        },
      }

      // Well past any reasonable lease — 10 minutes, longer than the whole
      // 5-minute Cron Trigger cadence this module's own doc bounds the lease
      // against.
      vi.advanceTimersByTime(10 * 60 * 1000)

      await processRow(env, provider, queuedRowFrom(seeded))

      expect(sendCalls, "an expired lease must not block a fresh claim").toBe(1)
      expect(store.get("outbox-1")?.status).toBe("sent")
      expect(store.get("outbox-1")?.attempts).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a claim whose lease is still live blocks a fresh claim attempt", async () => {
    // The mirror image of the self-heal test above: a recent, still-live
    // claim must keep blocking, not just an expired one.
    const seeded = seedRow({ attempts: 1, claimed_at: new Date().toISOString() })
    const { DB, store } = fakeDrainDB([seeded])
    const env = { DB } as unknown as Env

    let sendCalls = 0
    const provider: MailProvider = {
      async send() {
        sendCalls++
        return { ok: true, providerMessageId: "should-not-happen" }
      },
    }

    await processRow(env, provider, queuedRowFrom(seeded))

    expect(sendCalls, "a live lease must block a second claim attempt").toBe(0)
    expect(store.get("outbox-1")?.attempts, "a blocked claim must not perturb the row").toBe(1)
    expect(store.get("outbox-1")?.status).toBe("queued")
  })
})

describe("processRow — the CTA link (issue #83)", () => {
  it("carries an absolute CTA to the provider when PUBLIC_BASE_URL is set", async () => {
    const seeded = seedRow({ cta_text: "Review the design", cta_href: "/submissions/SUB-ABC123" })
    const { DB } = fakeDrainDB([seeded])
    const env = { DB, PUBLIC_BASE_URL: "https://portal.example.test" } as unknown as Env

    let captured: OutboundEmail | undefined
    const provider: MailProvider = {
      async send(email) {
        captured = email
        return { ok: true, providerMessageId: "fake-msg-cta" }
      },
    }

    await processRow(env, provider, queuedRowFrom(seeded))

    expect(captured?.ctaText).toBe("Review the design")
    expect(captured?.ctaHref).toBe("https://portal.example.test/submissions/SUB-ABC123")
  })

  it("resolves a base URL that carries its own path as a prefix, not a replacement", async () => {
    const seeded = seedRow({ cta_href: "/submissions/SUB-ABC123" })
    const { DB } = fakeDrainDB([seeded])
    const env = { DB, PUBLIC_BASE_URL: "https://portal.example.test" } as unknown as Env

    let captured: OutboundEmail | undefined
    const provider: MailProvider = {
      async send(email) {
        captured = email
        return { ok: true, providerMessageId: "fake-msg-cta2" }
      },
    }

    await processRow(env, provider, queuedRowFrom(seeded))

    const url = new URL(captured?.ctaHref ?? "")
    expect(url.protocol).toBe("https:")
    expect(url.hostname).toBe("portal.example.test")
    expect(url.pathname).toBe("/submissions/SUB-ABC123")
  })

  it("sends no CTA at all, and warns, when PUBLIC_BASE_URL is unset — identical to pre-#83 behaviour", async () => {
    const seeded = seedRow({ cta_text: "Review the design", cta_href: "/submissions/SUB-ABC123" })
    const { DB, store } = fakeDrainDB([seeded])
    const env = { DB } as unknown as Env

    let captured: OutboundEmail | undefined
    const provider: MailProvider = {
      async send(email) {
        captured = email
        return { ok: true, providerMessageId: "fake-msg-nolink" }
      },
    }

    await processRow(env, provider, queuedRowFrom(seeded))

    expect(captured?.ctaHref).toBeUndefined()
    expect(captured?.ctaText).toBeUndefined()
    expect(captured?.body).toBe(seeded.body)
    expect(store.get("outbox-1")?.status, "an unset base URL must not block the send itself").toBe(
      "sent",
    )
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("PUBLIC_BASE_URL"))
  })

  it("sends no CTA at all when PUBLIC_BASE_URL is set but unparseable, never a broken link", async () => {
    const seeded = seedRow({ cta_href: "/submissions/SUB-ABC123" })
    const { DB } = fakeDrainDB([seeded])
    const env = { DB, PUBLIC_BASE_URL: "not a url" } as unknown as Env

    let captured: OutboundEmail | undefined
    const provider: MailProvider = {
      async send(email) {
        captured = email
        return { ok: true, providerMessageId: "fake-msg-badbase" }
      },
    }

    await processRow(env, provider, queuedRowFrom(seeded))

    expect(captured?.ctaHref).toBeUndefined()
    expect(captured?.ctaText).toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("PUBLIC_BASE_URL"))
  })
})

describe("drainOutbox — the batch", () => {
  it("is a no-op against an empty queue", async () => {
    const { DB } = fakeDrainDB([])
    const env = { DB, MAIL_PROVIDER: "fake" } as unknown as Env
    await expect(drainOutbox(env)).resolves.toBeUndefined()
  })

  it("drains every currently queued row in one pass, not just the first", async () => {
    const rows = [
      seedRow({ id: "outbox-1", to_email: "rota-a@example.test", queued_at: "2026-08-11T00:00:01.000Z" }),
      seedRow({ id: "outbox-2", to_email: "rota-b@example.test", queued_at: "2026-08-11T00:00:02.000Z" }),
      seedRow({ id: "outbox-3", to_email: "rota-c@example.test", queued_at: "2026-08-11T00:00:03.000Z" }),
    ]
    const { DB, store } = fakeDrainDB(rows)
    const env = { DB, MAIL_PROVIDER: "fake" } as unknown as Env

    await drainOutbox(env)

    for (const id of ["outbox-1", "outbox-2", "outbox-3"]) {
      expect(store.get(id)?.status, id).toBe("sent")
    }
  })

  it("selects the fake provider end to end via MAIL_PROVIDER, using its mailfail hook", async () => {
    const rows = [
      seedRow({ id: "outbox-1", to_email: "rota-drain-moves@example.test" }),
      seedRow({ id: "outbox-2", to_email: "rota-mailfail-retry@example.test" }),
    ]
    const { DB, store } = fakeDrainDB(rows)
    const env = { DB, MAIL_PROVIDER: "fake" } as unknown as Env

    await drainOutbox(env)

    expect(store.get("outbox-1")?.status).toBe("sent")
    expect(store.get("outbox-2")?.status, "one failure is a retry, not a give-up").toBe("queued")
    expect(store.get("outbox-2")?.attempts).toBe(1)
  })
})
