/**
 * A stand-in for Cloudflare Access's signing key, so the verified path (#70)
 * can be tested for real rather than against a stub of itself.
 *
 * Every token below is signed with a key pair this process generated a
 * millisecond ago and throws away when it exits. Nothing here touches
 * Cloudflare, and no value in this file resembles a real credential — see
 * CLAUDE.md rule 1.
 */

export interface TokenClaims {
  [claim: string]: unknown
}

export interface AccessSigner {
  kid: string
  /** The JWKS document `<issuer>/cdn-cgi/access/certs` would return. */
  jwks(): Promise<unknown>
  /** Signs `claims` with this signer's key. */
  sign(claims: TokenClaims, options?: { kid?: string; alg?: string }): Promise<string>
}

const ALGORITHM = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const

export async function accessSigner(kid = "test-key-1"): Promise<AccessSigner> {
  const pair = (await crypto.subtle.generateKey(ALGORITHM, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair

  return {
    kid,
    async jwks() {
      const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as unknown as Record<
        string,
        unknown
      >
      return { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }
    },
    async sign(claims, options = {}) {
      const header = base64Url(
        new TextEncoder().encode(
          JSON.stringify({ alg: options.alg ?? "RS256", kid: options.kid ?? kid, typ: "JWT" }),
        ),
      )
      const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)))
      const signature = await crypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5" },
        pair.privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
      )
      return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`
    },
  }
}

/** A JWT-shaped string with a signature that is not one. */
export function unsignedToken(claims: TokenClaims, kid = "test-key-1"): string {
  const encode = (value: unknown) =>
    base64Url(new TextEncoder().encode(JSON.stringify(value)))
  return `${encode({ alg: "none", kid, typ: "JWT" })}.${encode(claims)}.not-a-signature`
}

/** Seconds since the epoch, `offsetSeconds` from now — for `exp` / `iat`. */
export function epoch(offsetSeconds = 0): number {
  return Math.floor(Date.now() / 1000) + offsetSeconds
}

function base64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
