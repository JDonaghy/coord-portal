import { describe, expect, it } from "vitest"

import { chunkForBinding, D1_MAX_BOUND_PARAMS } from "../src/d1"
import { loadSignoffStates } from "../src/rounds"
import { loadStartWorkStates } from "../src/startWork"
import type { Env } from "../src/types"

/**
 * Unit coverage for D1's 100-bound-parameter ceiling and the two batch loaders
 * that used to walk straight into it — `/requests` (#104) asks both of them
 * about every submission the portal holds, so past 100 rows the whole screen
 * became a 500 (`D1_ERROR: too many SQL variables ...: SQLITE_ERROR`).
 *
 * This file mocks D1, which `test/startWork.test.ts` and
 * `test/previewReviews.test.ts` both deliberately refuse to do — "a mocked D1
 * here would only prove the stub does what this file told it to do." The
 * exception is narrow and holds: the property asserted below is not about what
 * D1 *does* with a statement, it is about the statement this code *builds* —
 * how many placeholders it puts in one `IN (...)`, and that it covers every
 * reference exactly once across however many statements it splits into. A stub
 * is the only place that is observable at all; the real database's opinion of
 * the result is covered black-box, past the ceiling, in
 * `e2e/requests.spec.ts`.
 */

interface Recorded {
  sql: string
  params: unknown[]
}

/**
 * An `Env` whose D1 records each prepared statement and answers `.all()` from
 * `rowsFor`, so a test can assert on both the statements built and the merged
 * result.
 */
function recordingEnv(
  recorded: Recorded[],
  rowsFor: (params: unknown[]) => Record<string, unknown>[],
): Env {
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          recorded.push({ sql, params })
          return {
            async all() {
              return { results: rowsFor(params) }
            },
          }
        },
      }
    },
  }
  return { DB } as unknown as Env
}

const references = (count: number): string[] =>
  Array.from({ length: count }, (_unused, i) => `sub_${String(i).padStart(6, "0")}`)

/** Every `?` in one statement, which is what D1 counts against the ceiling. */
const placeholderCount = (sql: string): number => (sql.match(/\?/g) ?? []).length

describe("chunkForBinding", () => {
  it("issues no chunk at all for an empty list", () => {
    expect(chunkForBinding([])).toEqual([])
  })

  it("keeps a list at or under the ceiling in one chunk", () => {
    expect(chunkForBinding(references(1))).toHaveLength(1)
    expect(chunkForBinding(references(D1_MAX_BOUND_PARAMS))).toHaveLength(1)
  })

  it("splits one past the ceiling, and splits evenly on an exact multiple", () => {
    expect(chunkForBinding(references(D1_MAX_BOUND_PARAMS + 1)).map((c) => c.length)).toEqual([
      D1_MAX_BOUND_PARAMS,
      1,
    ])
    expect(chunkForBinding(references(D1_MAX_BOUND_PARAMS * 3)).map((c) => c.length)).toEqual([
      D1_MAX_BOUND_PARAMS,
      D1_MAX_BOUND_PARAMS,
      D1_MAX_BOUND_PARAMS,
    ])
  })

  it("preserves order and loses nothing", () => {
    const all = references(251)
    expect(chunkForBinding(all).flat()).toEqual(all)
  })

  it("honours a caller's smaller size, for a statement that binds more than the list", () => {
    expect(chunkForBinding(references(5), 2).map((c) => c.length)).toEqual([2, 2, 1])
  })

  it("refuses a size that could never terminate", () => {
    expect(() => chunkForBinding(references(3), 0)).toThrow(RangeError)
  })
})

describe("loadSignoffStates past D1's bound-parameter ceiling", () => {
  it("never binds more than the ceiling in one statement, and covers every reference once", async () => {
    const recorded: Recorded[] = []
    const all = references(251)
    const env = recordingEnv(recorded, () => [])

    await loadSignoffStates(env, all)

    expect(recorded).toHaveLength(3)
    for (const { sql, params } of recorded) {
      expect(params.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS)
      expect(placeholderCount(sql)).toBe(params.length)
    }
    expect(recorded.flatMap((r) => r.params)).toEqual(all)
  })

  it("merges the rows every chunk returned, not just the first", async () => {
    const all = references(251)
    const first = all[0]
    const last = all[all.length - 1]
    if (!first || !last) throw new Error("fixture produced no references")

    const env = recordingEnv([], (params) =>
      params
        .filter((p) => p === first || p === last)
        .map((p) => ({ submission_id: p, round: 2, verdict: "approved" })),
    )

    const states = await loadSignoffStates(env, all)

    // `first` lands in chunk 0 and `last` in chunk 2 — a merge that dropped
    // either chunk would lose one of these.
    expect(states.size).toBe(2)
    expect(states.get(first)).toEqual({ round: 2, verdict: "approved" })
    expect(states.get(last)).toEqual({ round: 2, verdict: "approved" })
  })

  it("issues no statement at all for an empty list", async () => {
    const recorded: Recorded[] = []
    const states = await loadSignoffStates(recordingEnv(recorded, () => []), [])
    expect(states.size).toBe(0)
    expect(recorded).toEqual([])
  })
})

describe("loadStartWorkStates past D1's bound-parameter ceiling", () => {
  it("never binds more than the ceiling in one statement, and covers every reference once", async () => {
    const recorded: Recorded[] = []
    const all = references(205)
    const env = recordingEnv(recorded, () => [])

    await loadStartWorkStates(env, all)

    expect(recorded).toHaveLength(3)
    for (const { sql, params } of recorded) {
      expect(params.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS)
      expect(placeholderCount(sql)).toBe(params.length)
    }
    expect(recorded.flatMap((r) => r.params)).toEqual(all)
  })

  it("merges the rows every chunk returned, not just the first", async () => {
    const all = references(205)
    const last = all[all.length - 1]
    if (!last) throw new Error("fixture produced no references")

    const env = recordingEnv([], (params) =>
      params
        .filter((p) => p === last)
        .map((p) => ({ submission_id: p, started_at: "2026-08-01T00:00:00.000Z" })),
    )

    const states = await loadStartWorkStates(env, all)

    expect(states.size).toBe(1)
    expect(states.get(last)).toEqual({ startedAt: "2026-08-01T00:00:00.000Z" })
  })

  it("issues no statement at all for an empty list", async () => {
    const recorded: Recorded[] = []
    const states = await loadStartWorkStates(recordingEnv(recorded, () => []), [])
    expect(states.size).toBe(0)
    expect(recorded).toEqual([])
  })
})
