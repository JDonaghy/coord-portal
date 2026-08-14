import { describe, expect, it } from "vitest"

import { parseFormData } from "../src/formData"

/**
 * Unit coverage for the shared helper issue #71 introduced: `request.formData()`
 * throws a raw `TypeError` on a malformed body, and `parseFormData` is the one
 * place that turns that throw into a plain `null` so every route can pick its
 * own refusal shape (see the routes' own e2e coverage in `e2e/start-bot-gate.spec.ts`
 * and `e2e/intake.spec.ts` for the black-box behaviour this unblocks).
 *
 * CLAUDE.md marks unit tests "welcome but not the acceptance bar" — this file
 * exists alongside the e2e coverage, not instead of it.
 */
describe("parseFormData", () => {
  it("parses a well-formed urlencoded body", async () => {
    const request = new Request("https://portal.test/x", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ summary: "hello" }).toString(),
    })

    const form = await parseFormData(request)
    expect(form).not.toBeNull()
    expect(form?.get("summary")).toBe("hello")
  })

  it("parses a well-formed multipart body", async () => {
    const body = new FormData()
    body.set("summary", "hello")
    const request = new Request("https://portal.test/x", { method: "POST", body })

    const form = await parseFormData(request)
    expect(form).not.toBeNull()
    expect(form?.get("summary")).toBe("hello")
  })

  it("returns null instead of throwing on a JSON content-type body", async () => {
    const request = new Request("https://portal.test/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })

    await expect(parseFormData(request)).resolves.toBeNull()
  })

  it("returns null instead of throwing on a plain-text body", async () => {
    const request = new Request("https://portal.test/x", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    })

    await expect(parseFormData(request)).resolves.toBeNull()
  })

  it("returns null instead of throwing on multipart/form-data with no boundary=", async () => {
    const request = new Request("https://portal.test/x", {
      method: "POST",
      headers: { "content-type": "multipart/form-data" },
      body: "--x\r\nnot a part\r\n--x--",
    })

    await expect(parseFormData(request)).resolves.toBeNull()
  })

  it("returns null instead of throwing on multipart/form-data with an unused boundary=", async () => {
    const request = new Request("https://portal.test/x", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=----absent" },
      body: "this body contains no part delimiters at all",
    })

    await expect(parseFormData(request)).resolves.toBeNull()
  })

  it("returns null instead of throwing when there is no body at all", async () => {
    const request = new Request("https://portal.test/x", { method: "POST" })

    await expect(parseFormData(request)).resolves.toBeNull()
  })
})
