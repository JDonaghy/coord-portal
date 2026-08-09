/**
 * Portal-minted identifiers.
 *
 * Neither the URL id nor the customer-facing reference is a GitHub issue
 * number, a branch name or anything else coord-side — see contract note 6
 * ("the opaque SUB-XXXXXX reference ... is a portal-minted id, not a GitHub
 * number"). Both are generated here, independently of each other, so a
 * customer who quotes a reference back to support never leaks the row id and
 * vice versa.
 */

/** `sub_` + 12 lowercase hex chars. Used only in URLs, never read aloud. */
export function generateSubmissionId(): string {
  return `sub_${randomHex(12)}`
}

/**
 * `SUB-XXXXXX` where `XXXXXX` is six upper-case hex characters — a subset of
 * `[A-Z0-9]`, the alphabet the contract and mock both use, and one Playwright
 * can assert against without pinning more than either source commits to.
 */
export function generateSubmissionReference(): string {
  return `SUB-${randomHex(6).toUpperCase()}`
}

function randomHex(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length)
}
