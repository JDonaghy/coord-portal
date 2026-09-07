import { describe, expect, it } from "vitest"

import { surveySection } from "../src/routes/submission"
import { parseSurveyRating, SURVEY_RATING_LABELS, SURVEY_RATINGS } from "../src/surveys"
import type { Submission } from "../src/submissions"

/**
 * Unit coverage for the decidable parts of the shipped survey (issue #328):
 * the closed 1–5 rating vocabulary's parser, and the pure render split
 * between "no response yet" (the button and its composer) and "a response is
 * on file" (the read-back, no button, no edit path) — the same split
 * `test/shippedResultSection.test.ts` documents for `shippedResultSection`.
 * The database-backed parts — a response actually landing once, a second
 * attempt being refused, the button appearing only on `shipped` — need a real
 * D1 and are covered black-box in `e2e/survey.spec.ts`.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: "sub_000001",
    reference: "SUB-000001",
    status: "shipped",
    customerEmail: "customer@example.test",
    outcome: "A printable watering rota for the community greenhouse.",
    audience: "Saturday volunteers",
    doneDefinition: "Anyone on shift can see which beds are due without asking.",
    constraints: null,
    projectScope: null,
    createdAt: "2026-01-01T00:00:00Z",
    coordRevision: 3,
    projectId: null,
    previewUrl: null,
    ...overrides,
  }
}

describe("parseSurveyRating", () => {
  it("reads each of the five pinned values", () => {
    for (const value of SURVEY_RATINGS) {
      expect(parseSurveyRating(String(value))).toBe(value)
    }
  })

  it("is null for a blank, out-of-range or non-numeric rating", () => {
    expect(parseSurveyRating("")).toBeNull()
    expect(parseSurveyRating("  ")).toBeNull()
    expect(parseSurveyRating("0")).toBeNull()
    expect(parseSurveyRating("6")).toBeNull()
    expect(parseSurveyRating("-1")).toBeNull()
    expect(parseSurveyRating("three")).toBeNull()
    expect(parseSurveyRating("3.5")).toBeNull()
  })

  it("does not accept trailing garbage a bare regex slice might miss", () => {
    expect(parseSurveyRating("5 OR 1=1")).toBeNull()
    expect(parseSurveyRating("05")).toBeNull()
  })
})

describe("SURVEY_RATING_LABELS", () => {
  it("gives every pinned rating a non-empty, distinct label", () => {
    const labels = SURVEY_RATINGS.map((value) => SURVEY_RATING_LABELS[value])
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0)
    }
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe("surveySection", () => {
  it("renders the button and composer, and no response card, when nobody has answered yet", () => {
    const markup = surveySection(submission(), null)
    expect(markup).toContain('data-testid="survey-open-button"')
    expect(markup).toContain('data-testid="survey-form"')
    expect(markup).not.toContain('data-testid="survey-response"')
  })

  it("renders every one of the five rating options as a real radio input", () => {
    const markup = surveySection(submission(), null)
    for (const value of SURVEY_RATINGS) {
      expect(markup).toContain(`<input type="radio" name="rating" value="${value}" required>`)
    }
  })

  it("renders the read-back, and no button, once a response is on file", () => {
    const markup = surveySection(submission(), {
      rating: 5,
      comment: "Exactly what we needed.",
      createdAt: "2026-02-01T00:00:00Z",
    })
    expect(markup).toContain('data-testid="survey-response"')
    expect(markup).toContain('data-testid="survey-thanks"')
    expect(markup).toContain("Exactly what we needed.")
    expect(markup).not.toContain('data-testid="survey-open-button"')
    expect(markup).not.toContain('data-testid="survey-form"')
  })

  it("renders no comment line when the customer left the comment blank", () => {
    const markup = surveySection(submission(), {
      rating: 3,
      comment: null,
      createdAt: "2026-02-01T00:00:00Z",
    })
    expect(markup).not.toContain('data-testid="survey-response-comment"')
  })

  it("escapes a comment carrying HTML-significant characters", () => {
    const markup = surveySection(submission(), {
      rating: 2,
      comment: '<script>alert("x")</script>',
      createdAt: "2026-02-01T00:00:00Z",
    })
    expect(markup).not.toContain("<script>")
    expect(markup).toContain("&lt;script&gt;")
  })

  it("reopens the composer with the error message when redisplayed after a rejected submit", () => {
    const markup = surveySection(submission(), null, {
      composerOpen: true,
      error: "Choose a rating before sending.",
    })
    expect(markup).toContain('data-testid="survey-error"')
    expect(markup).toContain("Choose a rating before sending.")
    expect(markup).toContain('id="survey-toggle" data-testid="survey-toggle" aria-label="Let us know how we did" checked')
  })
})
