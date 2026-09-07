-- 0028_submission_surveys — issue #328: ask the customer how we did when a
-- project ships.
--
-- One table, portal-owned outright — unlike `design_rounds`/`signoffs` or
-- `preview_reviews`/their review, there is no coord-owned half here at all.
-- The rating and comment are both authored by the customer, on the shipped
-- screen, and read back only on that same screen (`src/routes/submission.ts`).
-- No column here is ever written by a bridge push, and no row here is ever
-- read by one — see `src/surveys.ts`'s module comment for why this
-- deliberately never becomes a `bridge_events` row.
--
-- ── ONE RESPONSE PER SUBMISSION ─────────────────────────────────────────────
-- `submission_id` is the primary key by itself, not part of a composite key
-- the way `preview_reviews` keys on `(submission_id, preview_url)` — a preview
-- build can recur, but issue #328 is explicit that a submission only ever gets
-- one survey, ever: "after it is given, the shipped screen shows what they
-- said rather than the button, with no edit path." `src/surveys.ts`'s
-- `recordSurveyResponse` relies on exactly this key for its `INSERT OR IGNORE`
-- idempotency guard — a second attempt at the same submission_id is a no-op,
-- not an error and not an overwrite.
--
-- ── THE COLUMNS ──────────────────────────────────────────────────────────────
--   submission_id  the customer-visible SUB-XXXXXX reference, the same wire
--                  identity every other portal table here keys on.
--   rating         1–5, the one required field — "nothing is required except
--                  the rating."
--   comment        optional free text, NULL when the customer left it blank.
--   created_at     when the response was given; there is no `updated_at`
--                  because there is no update path — see above.
CREATE TABLE IF NOT EXISTS submission_surveys (
  submission_id  TEXT PRIMARY KEY,
  rating         INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment        TEXT,
  created_at     TEXT NOT NULL
);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0028')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
