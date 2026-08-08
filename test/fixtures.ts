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
  portalEnv?: string
}

export function fakeEnv(options: FakeEnvOptions = {}): Env {
  const { schemaVersion = "0001", d1Throws, r2Throws, portalEnv = "test" } = options

  const DB = {
    prepare(_sql: string) {
      return {
        async first<T>(): Promise<T | null> {
          if (d1Throws) throw d1Throws
          return schemaVersion === null ? null : ({ value: schemaVersion } as T)
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
    PORTAL_ENV: portalEnv,
  } as unknown as Env
}

export function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://portal.test${path}`, { method: "GET", headers })
}
