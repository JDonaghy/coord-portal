import { describe, expect, it } from "vitest"

import pkg from "../package.json"
import { VERSION } from "../src/version"

describe("version", () => {
  // /api/health is what an uptime check and a deploy verification read. If it
  // reports a version the package never shipped, both are lying.
  it("matches package.json", () => {
    expect(VERSION).toBe(pkg.version)
  })
})
