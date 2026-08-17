import { describe, expect, it } from "vitest"

import { LIFECYCLE_EVENT_KINDS, readLifecyclePatch } from "../src/lifecycle"

/**
 * Unit coverage for the decidable part of the dev-lifecycle timeline (issue
 * #111): the liberal reader for coord's `lifecycle_event` push, and the wall
 * that keeps a preview link customer-safe.
 *
 * The parts that need a real database — an event materialising from a bridge
 * push, a doubled push landing exactly once, the timeline rendering on the
 * submission detail screen — are covered black-box in
 * `e2e/lifecycle.spec.ts` against `wrangler dev` with real D1, for the same
 * reason `test/rounds.test.ts` gives: a mocked D1 would only prove the stub
 * does what I wrote it to do.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

describe("readLifecyclePatch", () => {
  it("says nothing when the push does not mention a lifecycle event", () => {
    expect(readLifecyclePatch({ status: "in-progress" })).toBeNull()
  })

  it("reads a bare kind string", () => {
    expect(readLifecyclePatch({ lifecycle_event: "review-opened" })).toEqual({
      kind: "review-opened",
      occurredAt: null,
      url: null,
    })
  })

  it("reads a kind plus timestamp from an object", () => {
    expect(
      readLifecyclePatch({
        lifecycle_event: { kind: "merged", occurred_at: "2026-08-10T09:00:00.000Z" },
      }),
    ).toEqual({ kind: "merged", occurredAt: "2026-08-10T09:00:00.000Z", url: null })
  })

  it("drops a kind outside the closed vocabulary rather than guessing at one", () => {
    expect(readLifecyclePatch({ lifecycle_event: { kind: "issue_opened" } })).toBeNull()
    expect(readLifecyclePatch({ lifecycle_event: "branch_pushed" })).toBeNull()
  })

  it("drops an unreadable timestamp rather than storing garbage", () => {
    const patch = readLifecyclePatch({
      lifecycle_event: { kind: "work-started", occurred_at: "not a date" },
    })
    expect(patch?.occurredAt).toBeNull()
  })

  it("carries a preview URL only for preview-ready", () => {
    const patch = readLifecyclePatch({
      lifecycle_event: { kind: "preview-ready", url: "https://preview.example.test/build-42" },
    })
    expect(patch).toEqual({
      kind: "preview-ready",
      occurredAt: null,
      url: "https://preview.example.test/build-42",
    })
  })

  it("drops a URL pushed on any other kind — the link is a preview-only exception", () => {
    const patch = readLifecyclePatch({
      lifecycle_event: { kind: "merged", url: "https://preview.example.test/build-42" },
    })
    expect(patch?.url).toBeNull()
  })

  it("refuses a github.com link even on preview-ready — the wall stays the wall", () => {
    const patch = readLifecyclePatch({
      lifecycle_event: { kind: "preview-ready", url: "https://github.com/example/repo/pull/9" },
    })
    expect(patch?.url).toBeNull()
  })

  it("refuses a non-https URL", () => {
    const patch = readLifecyclePatch({
      lifecycle_event: { kind: "preview-ready", url: "http://preview.example.test/build-42" },
    })
    expect(patch?.url).toBeNull()
  })

  it("refuses a value that is not a URL at all", () => {
    const patch = readLifecyclePatch({
      lifecycle_event: { kind: "preview-ready", url: "not a url" },
    })
    expect(patch?.url).toBeNull()
  })
})

describe("the pinned lifecycle-event vocabulary", () => {
  it("is exactly the seven kinds this screen knows how to render", () => {
    expect([...LIFECYCLE_EVENT_KINDS]).toEqual([
      "work-started",
      "review-opened",
      "checks-passing",
      "checks-attention",
      "preview-ready",
      "merged",
      "deployed",
    ])
  })
})
