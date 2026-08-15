// Type surface for acceptance-verdict.mjs, consumed only by
// test/acceptance-verdict.test.ts (typecheck's "test/**/*.ts" include,
// tsconfig.json). The script itself runs directly under Node in CI
// (.github/workflows/ci.yml) and is never compiled, so this file exists
// purely so the unit test gets real types instead of `any` — keep it in
// sync with the JSDoc in acceptance-verdict.mjs, not the other way around.

export type TestStatus = "pass" | "fail" | "skip"

export interface TestResult {
  id: string
  status: TestStatus
}

export interface Verdict {
  total: number
  realFailures: TestResult[]
  unexpectedGreen: string[]
  expectedRedStillRed: string[]
  missingExpectedRedIds: string[]
  ciGreen: boolean
}

export declare class VerdictError extends Error {}

export declare function parsePlaywrightReport(reportText: string): TestResult[]

export declare function loadExpectedRed(manifestText: string, source: string): Map<string, number>

export declare function buildVerdict(tests: TestResult[], expectedRed: Map<string, number>): Verdict
