/**
 * The one D1 limit that a "load these N rows in one statement" helper can hit
 * silently in dev and fatally in production: **a prepared statement may carry
 * at most 100 bound parameters.** Exceed it and D1 rejects the whole statement
 * with `D1_ERROR: too many SQL variables ...: SQLITE_ERROR`, which surfaces as
 * a 500 on whatever page issued it.
 *
 * This bites exactly the batch loaders that build `IN (?, ?, ...)` from a
 * caller-supplied list — `loadSignoffStates` (`src/rounds.ts`) and
 * `loadStartWorkStates` (`src/startWork.ts`). Both were written for
 * `/submissions`, where the list is one customer's own submissions and is
 * small in practice, so the ceiling was never reached. `/requests` (#104) is
 * the unscoped counterpart: its list is *every* submission the portal holds,
 * so the ceiling is reached the moment the table passes 100 rows — a page that
 * works on a fresh database and 500s permanently on a real one. The CI e2e
 * suite reproduces it precisely because it accumulates submissions across
 * every spec in the run.
 *
 * The fix has to live in the loaders rather than in `/requests`, because the
 * bug is not specific to `/requests`: a single customer with 101 submissions
 * would take their own dashboard down the same way.
 */

/**
 * D1's documented maximum bound parameters per query.
 *
 * `chunkForBinding` splits at exactly this, so a helper that binds anything
 * *beyond* the chunked list must split at a smaller size — pass its own
 * reduced value rather than editing this constant.
 */
export const D1_MAX_BOUND_PARAMS = 100

/**
 * Split `items` into runs of at most `size`, so each run can be bound to one
 * statement. Preserves order; returns `[]` for an empty input (callers rely on
 * that to issue no query at all).
 */
export function chunkForBinding<T>(items: T[], size: number = D1_MAX_BOUND_PARAMS): T[][] {
  if (size < 1) throw new RangeError(`chunk size must be at least 1, got ${size}`)
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}
