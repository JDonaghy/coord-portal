import { execFileSync } from "node:child_process"
import { join } from "node:path"

/**
 * The one place `e2e/` shells out to the `wrangler` CLI.
 *
 * Two fixtures need to reach the same `--local` miniflare state that
 * `serve:test`'s long-lived `wrangler dev` is serving from, because there is
 * no HTTP route on this side to seed through: `outbox-fixtures.ts` drives an
 * `outbox` row to `sent`/`failed` (only #50's drain will ever do that through
 * the app) and `r2-fixtures.ts` puts a mock bundle into R2 (the bucket is
 * populated coord-side). Each of those files explains its own why; this file
 * owns the *how*, because the how has one sharp edge both of them share.
 *
 * ── WHY THE RETRY ─────────────────────────────────────────────────────────
 * `wrangler d1 execute --local` and `wrangler r2 object put --local` open the
 * same `.wrangler/state/v3` SQLite files the running `wrangler dev` already
 * has open. SQLite's default `busy_timeout` is 0, so the two processes do not
 * queue behind each other — whichever one arrives while the other holds the
 * write lock fails immediately with `SQLITE_BUSY: database is locked`.
 *
 * That window is small but it is not empty, and a fixture sits right on top
 * of it: `deliveries.spec.ts` and `notifications.spec.ts` seed a submission
 * through the browser and then immediately shell out to read the row the app
 * just queued, so the CLI opens the database at the exact moment `wrangler
 * dev` is still settling that write. Reproduced directly (2026-08-21): a full
 * `npm run test:e2e` run took `Command failed: wrangler d1 execute ... e =
 * workerd/util/sqlite.c++:1671: failed: SENTRY_DO SQLite failed; NOSENTRY
 * database is locked: SQLITE_BUSY`, and in the worse arm of the same race
 * `workerd` itself raised that as an uncaught internal error and the dev
 * server died mid-suite — the messageless `✘ [ERROR]` death issue #81 filed,
 * which then fails every remaining test with `ECONNREFUSED` and says nothing
 * about the lock that caused it.
 *
 * A contended lock is not a failure, it is a wait: the correct answer is to
 * back off and ask again, which is what `busy_timeout` would do for us if the
 * CLI exposed it. Retrying here keeps the fixture honest — it still drives the
 * real CLI against the real shared state, and a genuine error (bad SQL, a
 * missing table, a wrangler that will not start) still throws on the first
 * attempt, because only a busy-lock message is retried.
 */
const WRANGLER_BIN = join(process.cwd(), "node_modules", ".bin", "wrangler")

/** Both the CLI-side and the workerd-side spelling of the same contended lock. */
const BUSY_LOCK = /SQLITE_BUSY|database is locked/i

/** Total tries, not extra ones — attempt 1 is the ordinary uncontended case. */
const MAX_ATTEMPTS = 8

/**
 * Backoff is linear (50ms, 100ms, …), so all seven waits together add at most
 * ~1.4s to a call that keeps losing the race. Deliberately small: the lock is
 * held for milliseconds, and the slowest test in this suite
 * (`deliveries.spec.ts`) already spends five `wrangler` process spawns inside
 * Playwright's 30s per-test budget — a generous backoff here would buy
 * nothing and spend that budget on sleeping.
 */
const BACKOFF_STEP_MS = 50

/**
 * The fixtures that call this are synchronous by design — a Playwright test
 * seeds state and then asserts on it, with nothing to interleave — so this
 * blocks the thread rather than turning every caller async for the sake of a
 * sleep. `Atomics.wait` on a throwaway buffer is the supported way to do that
 * in Node; `execFileSync` above has already blocked the same thread anyway.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Everything wrangler said, wherever it said it — `message` alone omits stderr. */
function describeFailure(err: unknown): string {
  if (typeof err !== "object" || err === null) return String(err)
  const { message, stdout, stderr } = err as {
    message?: string
    stdout?: Buffer | string
    stderr?: Buffer | string
  }
  return [message, stdout?.toString(), stderr?.toString()].filter(Boolean).join("\n")
}

/**
 * Run the repo's own `wrangler` with `args`, returning its stdout.
 *
 * Throws with wrangler's stdout *and* stderr in the message: a bare
 * `execFileSync` error reports only the command line, which turns "your SQL
 * named a column that does not exist" into an unreadable failure.
 */
export function runWrangler(args: string[]): string {
  let lastFailure = ""

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return execFileSync(WRANGLER_BIN, args, {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      }).toString()
    } catch (err) {
      lastFailure = describeFailure(err)
      if (!BUSY_LOCK.test(lastFailure) || attempt === MAX_ATTEMPTS) {
        throw new Error(`wrangler ${args.join(" ")} failed:\n${lastFailure}`)
      }
      sleepSync(attempt * BACKOFF_STEP_MS)
    }
  }

  // Unreachable: the loop either returns or throws on its last attempt. Kept
  // so the function has no implicit `undefined` return path.
  throw new Error(`wrangler ${args.join(" ")} failed:\n${lastFailure}`)
}
