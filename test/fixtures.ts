import type { Env } from "../src/types"

/**
 * A fake Env good enough to drive the router in plain node.
 *
 * The real bindings are exercised end-to-end by the Playwright suite against
 * `wrangler dev` (e2e/), which is the acceptance bar. These stubs exist so
 * routing, status codes and error handling can be tested in milliseconds.
 *
 * Every value here is synthetic. Nothing that resembles a real customer's words
 * belongs in this repo — see CLAUDE.md.
 */
export interface FakeEnvOptions {
  schemaVersion?: string | null
  d1Throws?: Error
  r2Throws?: Error
  /** issue #197 — `GET /api/health`'s `checks.intake` probe, backed by `getIntakeHealthSnapshot`. */
  intakeLastReceivedAt?: string | null
  intakeRecentCount?: number
  intakeThrows?: Error
}

export function fakeEnv(options: FakeEnvOptions = {}): Env {
  const {
    schemaVersion = "0001",
    d1Throws,
    r2Throws,
    intakeLastReceivedAt = null,
    intakeRecentCount = 0,
    intakeThrows,
  } = options

  const DB = {
    prepare(sql: string) {
      // `getIntakeHealthSnapshot` (`src/inboundEmail.ts`) is the only query
      // this fake issues against `inbound_emails` — distinguished by table
      // name so `d1Throws`/`schemaVersion` keep governing the `schema_meta`
      // probe exactly as before, and every other existing caller of
      // `fakeEnv()` (none of which touch `inbound_emails`) sees no change.
      const isIntakeQuery = sql.includes("inbound_emails")
      const first = async <T>(): Promise<T | null> => {
        if (isIntakeQuery) {
          if (intakeThrows) throw intakeThrows
          return { last_received_at: intakeLastReceivedAt, recent_count: intakeRecentCount } as T
        }
        if (d1Throws) throw d1Throws
        return schemaVersion === null ? null : ({ value: schemaVersion } as T)
      }
      return {
        // `probeD1` (`src/routes/health.ts`) calls `first()` unbound;
        // `getIntakeHealthSnapshot` (`src/inboundEmail.ts`) binds a window
        // start first. Both read the same fake data either way — this fake
        // has no bound parameters to honour, only `intakeThrows`/the fixed
        // `intake*` fields above.
        first,
        bind(..._args: unknown[]) {
          return { first }
        },
      }
    },
  }

  const ARTIFACTS = {
    async head(_key: string): Promise<null> {
      if (r2Throws) throw r2Throws
      return null
    },
  }

  const ASSETS = {
    async fetch(_request: Request): Promise<Response> {
      return new Response("<!doctype html><title>stub</title>", {
        headers: { "content-type": "text/html" },
      })
    },
  }

  return {
    DB,
    ARTIFACTS,
    ASSETS,
  } as unknown as Env
}

export function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://portal.test${path}`, { method: "GET", headers })
}
