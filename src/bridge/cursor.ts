/**
 * The pull cursor.
 *
 * The wire contract calls it "opaque", so it is: a base64url blob the daemon
 * stores and hands back, never parses. Inside it is nothing more interesting
 * than the stream revision the daemon has already seen, but encoding it keeps
 * the daemon from growing a dependency on that — a later cursor that carries a
 * shard or a snapshot id must not be a breaking change on their side.
 *
 * A cursor is *positional, not temporal*: it names a revision, and `pull`
 * returns what sits after it. That is what makes a replay cheap and exact.
 */

const CURSOR_VERSION = "v1"

export function encodeCursor(revision: number): string {
  return base64UrlEncode(`${CURSOR_VERSION}:${revision}`)
}

/**
 * Returns the revision the cursor points at, or `null` if it is not a cursor
 * this portal issued.
 *
 * A cursor we cannot read is an error, not a silent rewind to the beginning:
 * a daemon with a corrupted cursor should be told, not handed the entire
 * history as though that were what it asked for.
 */
export function decodeCursor(raw: string): number | null {
  const decoded = base64UrlDecode(raw)
  if (decoded === null) return null

  const separator = decoded.indexOf(":")
  if (separator < 0) return null
  if (decoded.slice(0, separator) !== CURSOR_VERSION) return null

  const revision = Number(decoded.slice(separator + 1))
  if (!Number.isSafeInteger(revision) || revision < 0) return null
  return revision
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlDecode(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=")
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}
