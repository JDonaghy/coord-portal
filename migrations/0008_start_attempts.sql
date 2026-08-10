-- 0008_start_attempts — issue #32: storage for the coarse per-IP rate limit
-- on `POST /start`.
--
-- One row per POST /start attempt — accepted, Turnstile-rejected, rate-
-- limited, or a plain validation failure. Every attempt is recorded, not just
-- the ones that mint a lead: see `src/rateLimit.ts` for why the budget has to
-- be spent before the caller knows which check (if any) will also reject the
-- request.
--
-- `ip` is whatever `src/rateLimit.ts`'s `clientIp` resolves (`CF-Connecting-
-- IP`, the only IP surface a Cloudflare Worker has). `at` is ISO-8601; the
-- rate check is a sliding window over it — "N within the last WINDOW_MS", not
-- "N since the top of the clock minute" — so there is no reset seam to time a
-- burst around.
--
-- No foreign key and no relation to `leads`: an attempt is recorded whether
-- or not it ever became one, same reasoning as 0005's `leads` table carrying
-- no foreign key toward `submissions`.

CREATE TABLE IF NOT EXISTS start_attempts (
  ip  TEXT NOT NULL,
  at  TEXT NOT NULL
);

-- Every query filters by `ip` first, then `at` — the one index that matters.
CREATE INDEX IF NOT EXISTS idx_start_attempts_ip_at ON start_attempts (ip, at);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0008')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
