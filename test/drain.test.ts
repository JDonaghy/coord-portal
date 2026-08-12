import { describe, expect, it } from "vitest"
import { drainOutbox, processRow, type QueuedRow } from "../src/drain"
import type { MailProvider } from "../src/mailProvider"
import type { Env } from "../src/types"

/**
 * Unit coverage for issue #50's drain — the claiming compare-and-swap ("the
 * thing to get right") and the retry/give-up arc, against a minimal in-memory
 * fake of the exact D1 statements `src/drain.ts` issues. The real Worker
 * behaviour — actually invoked through `GET /__scheduled` — is the sealed
 * acceptance slice's job (`tests/acceptance/ms-3/50-drain.spec.ts`); this file
 * exists so the claim race and the attempt bookkeeping can be asserted in
 * milliseconds, and so a future change to either can fail fast in `npm test`
 * rather than only in the (much slower) acceptance run.
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
  attempts: number
  status: string
  last_error: string | null
  sent_at: string | null
  provider_message_id: string | null
  queued_at: string
}

function seedRow(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    id: overrides.id ?? "outbox-1",
    to_email: overrides.to_email ?? "rota-drain@example.test",
    from_email: "coord-portal <notify@intake.heurontech.com>",
    subject: "Your design is ready for sign-off",
    body: "We've put together a design. Take a look.",
    attempts: 0,
    status: "queued",
    last_error: null,
    sent_at: null,
    provider_message_id: null,
    queued_at: "2026-08-11T00:00:00.000Z",
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
                const results = [...store.values()]
                  .filter((row) => row.status === "queued")
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
                const [id, expectedAttempts] = args as [string, number]
                const row = store.get(id)
                const won = !!row && row.status === "queued" && row.attempts === expectedAttempts
                if (won && row) row.attempts += 1
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
                }
                return { meta: { changes: won ? 1 : 0 } }
              }
              if (statement.startsWith("UPDATE outbox SET last_error = ?")) {
                const [lastError, id] = args as [string, string]
                const row = store.get(id)
                const won = !!row && row.status === "queued"
                if (won && row) row.last_error = lastError
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
    attempts: stored.attempts,
  }
}

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
