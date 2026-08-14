/**
 * `request.formData()` throws a raw `TypeError` — an unhandled 500 — when the
 * request carries no `Content-Type` at all, one that can't be parsed as a
 * form, or a `multipart/form-data` header with a missing or malformed
 * `boundary=` (issue #46, extended to every route with an unguarded call by
 * issue #71: "a bot, a broken client, or a redirect replayed as a bare
 * POST"). That is a malformed request, not a server error.
 *
 * One shared parse, `FormData | null` rather than a thrown error, so every
 * caller decides its own refusal shape instead of copying the same
 * try/catch a third time — issue #71 is explicit that the routes
 * "deliberately differ" in what they render back (a 404 on the authenticated
 * submission route, the bot-gate banner on the public one, the existing
 * required-field message on intake), so this helper stops at returning
 * `null` and never picks a response on a caller's behalf.
 */
export async function parseFormData(request: Request): Promise<FormData | null> {
  try {
    return await request.formData()
  } catch {
    return null
  }
}
