/**
 * Reported by GET /api/health.
 *
 * Must equal the "version" field in package.json — `test/version.test.ts`
 * fails the build if they drift.
 */
export const VERSION = "0.0.1"
