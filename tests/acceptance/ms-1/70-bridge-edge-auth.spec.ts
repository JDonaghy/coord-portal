import { expect, test, type APIRequestContext } from "@playwright/test"
import { generateKeyPairSync, sign } from "node:crypto"

/**
 * ms-1 sealed acceptance slice — issue #70
 * "[portal] The bridge's Worker-side gate can never pass in production —
 *  Access strips the client secret it validates, so a correctly-configured
 *  daemon gets a flat 401"
 *
 * Written from `tests/acceptance/ms-1/contract.md` (§ "Sync bridge (issue #15)
 * — pinned wire contract", sub-§ "Auth — Access service token") and issue #70's
 * own scope/acceptance sections, without sight of any implementation of #70.
 *
 * WHAT THIS SLICE OWNS. Not the three bridge routes — issue #15's slice
 * (`15-sync-bridge.spec.ts`) owns their wire shape and is left exactly as it
 * is. This slice owns the *gate in front of them*, and specifically the half
 * of it that only exists behind Cloudflare's edge: after #70, a request that
 * came through the edge is authorised by a **verified Access JWT**, not by a
 * plaintext header pair the edge itself strips before the Worker sees it.
 *
 * THE SHAPE OF THE BUG DICTATES THE SHAPE OF THE SUITE. Issue #70's note to
 * the test-author is explicit: *"the interesting assertions here are all
 * refusals, and the easy mistake is a suite that only proves the happy path. A
 * gate that admits everybody passes a happy-path suite perfectly."* Every
 * clause below is therefore a refusal, plus two controls that must stay green
 * (the local path still authorises; the local path is not reachable from
 * behind the edge).
 *
 * THE VERIFIED HAPPY PATH IS NOT ASSERTED HERE, deliberately. Minting a token
 * this Worker would accept needs a key in the team's published JWKS, i.e. a
 * real Cloudflare Access team — which the sealed run has by design not got
 * (README.md: "no mocked bindings, no shared state between runs, no live
 * fleet, no network"), and which issue #70 forbids touching ("Never touch
 * production Cloudflare"). The end-to-end proof #70 names for itself is
 * `coord portal heartbeat` from the daemon host, which is a post-merge
 * verification, not something a sealed black-box suite can stand in for. What
 * a sealed suite *can* prove, and what actually protects this gate, is that
 * nothing unverified is ever admitted.
 *
 * ⚠ THIS SLICE WAS GREEN BEFORE #70 WAS IMPLEMENTED. Measured 2026-08-14
 * against `npm run serve:acceptance` on the unfixed Worker, `/api/bridge/pull`:
 *
 *     local + well-formed pair   → 200      edge + well-formed pair → 401
 *     local + nothing            → 401      edge + pair + JWT       → 401
 *                                           edge + nothing          → 401
 *
 * Every clause below already held. That is a property of the bug, not of the
 * suite: #70 is a *false negative* — behind the edge the gate admits nobody,
 * the daemon included — so there is no wrong-admission for a sealed run to
 * catch today, and no way to mint a token the fixed Worker would accept
 * without a real Access team (which #70 forbids touching). Read this suite as
 * a RATCHET on the fix, not as proof of it: it goes red the moment a fix
 * decodes instead of verifies, lets the local relaxation be reached behind the
 * edge, accepts a human identity as the daemon, or fails open on an
 * unreachable JWKS. The proof that #70 is *done* is the one #70 names for
 * itself — `coord portal heartbeat` from the daemon host, post-merge.
 *
 * HOW A SEALED RUN GETS "BEHIND THE EDGE".
 *
 * TODO(test-author): contract.md predates issue #70 and pins nothing about the
 * edge/local split — it pins only the two header names and "missing or invalid
 * credentials ⇒ 401, empty body". Issue #70 names the discriminator directly
 * ("`isBehindCloudflareEdge`, `src/deployment.ts`"), and that pre-existing
 * module documents the black-box signal as the `CF-Ray` header, added by the
 * edge on every request it forwards. It also documents the reading as
 * deliberately one-directional: *"a client that forges one only makes this
 * Worker treat it as more trusted infrastructure, i.e. stricter"*. Presenting
 * `CF-Ray` from a test is therefore using the module exactly as its own
 * contract says it is safe to be used — asking for the strict path — and never
 * asks for a grant. If a worker changes the marker, this slice needs the
 * contract amended, not the assertion relaxed.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every credential, key and claim below is invented and generated at
 * runtime. Nothing here is a real secret, and nothing here is committed as one.
 */

// ── credentials ─────────────────────────────────────────────────────────────

/**
 * The daemon's service-token credential, in the same env-overridable form
 * `15-sync-bridge.spec.ts` already uses so the two slices agree about what "a
 * well-formed pair" is. Invented values, matching Cloudflare's service-token
 * shape (a `.access`-suffixed id, a 64-hex secret).
 */
const CLIENT_ID =
  process.env.COORD_BRIDGE_CLIENT_ID ?? "9f2c17b4a8de40518c6b3ad0e75f1c62.access"
const CLIENT_SECRET =
  process.env.COORD_BRIDGE_CLIENT_SECRET ??
  "4d1e9c07b35a2f68e4c81079ba6d35f2c9017e4ab8d562309fc71ea48b0d63a5"

const SERVICE_TOKEN: Record<string, string> = {
  "CF-Access-Client-Id": CLIENT_ID,
  "CF-Access-Client-Secret": CLIENT_SECRET,
}

/**
 * What production actually delivers to the Worker, per #70's measurement table:
 * Access validates the pair at the edge and forwards the request with at least
 * one half of it removed. Kept as its own named shape because "the id survives,
 * the secret does not" is the precise production symptom — a gate that passes
 * on this is a gate that never had a secret to check.
 */
const SERVICE_TOKEN_ID_ONLY: Record<string, string> = {
  "CF-Access-Client-Id": CLIENT_ID,
}

/**
 * The edge marker — see the header comment. Shape matches a real `CF-Ray`.
 *
 * TODO(test-author): measured 2026-08-14 against `serve:acceptance` — a
 * *present but empty* `CF-Ray:` does NOT take the strict path (the bridge
 * answered 200 to a bare header pair alongside it, i.e. the local relaxation
 * stayed open). Not asserted either way: it is unclear whether the empty header
 * reaches the Worker at all or is dropped by the runtime, the contract is
 * silent on it, and it is not exploitable in production — Cloudflare *sets*
 * `CF-Ray` on every forwarded request rather than merging a client's. Recorded
 * because a worker changing the edge test should know the empty case exists.
 */
const EDGE: Record<string, string> = { "CF-Ray": "8f3c1d2e4a5b6c7d-LHR" }

const CUSTOMER_EMAIL = "grace@example.test"

// ── synthetic Access JWTs ───────────────────────────────────────────────────

/**
 * A throwaway RSA key generated per run. It is by construction absent from any
 * JWKS the Worker could fetch, which is what makes every token below
 * *unverifiable* rather than merely malformed — the distinction issue #70's
 * acceptance list turns on ("a well-formed but unverifiable token is refused").
 */
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })

const TEAM_ISSUER = "https://heurontech.cloudflareaccess.com"
/** A synthetic Access application AUD tag (Cloudflare's are 64 hex chars). */
const APP_AUD = "b71f04c8a29d3e5617ca80fb2d9e46315870ac9df2b1e6438905cd7ae213f0b4"

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url")
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

interface TokenOpts {
  iss?: string
  aud?: string | string[]
  exp?: number
  iat?: number
  nbf?: number
  /**
   * Issue #70 scope 1: a service-token JWT is *expected* to carry a
   * `common_name` naming the client id rather than an `email` — but the issue
   * says in as many words "verify this, do not assume it".
   *
   * TODO(test-author): so this slice never asserts that a `common_name` token
   * is *accepted*; it only ever uses one in refusal cases, where the claim
   * shape is the most favourable possible input to the gate. If the measured
   * claim turns out to be something else, every assertion below still holds —
   * they are all refusals, and a token the gate cannot even parse is refused
   * for at least as good a reason.
   */
  common_name?: string
  email?: string
  alg?: string
  kid?: string
  /** Replace the signature with garbage instead of signing. */
  forgeSignature?: boolean
}

/**
 * Mint a structurally valid, correctly-encoded JWT. Signed for real with the
 * throwaway key above unless `forgeSignature` says otherwise — so the *only*
 * thing wrong with the default token is that no published key set vouches for
 * it. That is the exact input a gate which decodes without verifying would
 * wave through.
 */
function mintToken(opts: TokenOpts = {}): string {
  const alg = opts.alg ?? "RS256"
  const header = {
    alg,
    typ: "JWT",
    kid: opts.kid ?? "9c1e4b7a2f5d8036be41a7c95d2308ef6714b0c8a39d52e6f0847bd1c93a2e5f",
  }
  const iat = opts.iat ?? nowSeconds() - 30
  const payload: Record<string, unknown> = {
    iss: opts.iss ?? TEAM_ISSUER,
    aud: opts.aud ?? APP_AUD,
    iat,
    nbf: opts.nbf ?? iat,
    exp: opts.exp ?? nowSeconds() + 900,
    sub: "",
    type: "app",
  }
  if (opts.common_name !== undefined) payload.common_name = opts.common_name
  if (opts.email !== undefined) payload.email = opts.email

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  if (alg === "none") return `${signingInput}.`
  if (opts.forgeSignature) {
    return `${signingInput}.${b64url("not-a-signature-just-bytes-in-the-right-place")}`
  }
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey)
  return `${signingInput}.${signature.toString("base64url")}`
}

/** The most favourable unverifiable token there is: everything right but the key. */
function wellFormedToken(): string {
  return mintToken({ common_name: CLIENT_ID })
}

function jwt(token: string): Record<string, string> {
  return { "Cf-Access-Jwt-Assertion": token }
}

// ── transport ───────────────────────────────────────────────────────────────

type Headers = Record<string, string>

const BRIDGE_ROUTES = ["pull", "push", "heartbeat"] as const
type BridgeRoute = (typeof BRIDGE_ROUTES)[number]

/**
 * Hit one bridge route with an exact header set. Nothing is added implicitly —
 * a gate test that lets a helper smuggle in a credential is testing the helper.
 */
function callBridge(
  request: APIRequestContext,
  route: BridgeRoute,
  headers: Headers,
) {
  if (route === "pull") return request.get("/api/bridge/pull", { headers })
  if (route === "heartbeat") {
    return request.post("/api/bridge/heartbeat", {
      data: { at: "2026-08-13T09:00:00Z" },
      headers,
    })
  }
  return request.post("/api/bridge/push", {
    data: {
      updates: [
        { submission_id: "SUB-000000", revision: 1, fields: { status: "planned" } },
      ],
    },
    headers,
  })
}

/**
 * Assert a header set is refused on every bridge route.
 *
 * "Refused" is pinned to exactly 401 by the contract ("Missing or invalid
 * credentials ⇒ 401, empty body … This is the *only* status-code-level failure
 * in this surface"), and #70 constraint 5 requires it be a refusal rather than
 * a crash: a 500 from an unreachable JWKS endpoint would be failing *loudly*,
 * not failing closed, and a 200 would be the bug this issue exists to fix.
 */
async function expectRefusedEverywhere(
  request: APIRequestContext,
  headers: Headers,
  why: string,
) {
  for (const route of BRIDGE_ROUTES) {
    const res = await callBridge(request, route, headers)
    expect(res.status(), `${why} — /api/bridge/${route}`).toBe(401)
    expect(res.ok(), `${why} — /api/bridge/${route} must not be a success`).toBe(false)
  }
}

function merge(...parts: Headers[]): Headers {
  return Object.assign({}, ...parts)
}

// ── the slice ───────────────────────────────────────────────────────────────

test.describe("ms-1 issue 70 bridge edge auth", () => {
  test("behind the edge, a request with no credential at all is refused", async ({
    request,
  }) => {
    // #70 acceptance, clause 1. The floor of the gate: whatever the fix does
    // with JWTs, arriving through the edge with nothing must never become a
    // way in.
    await expectRefusedEverywhere(request, EDGE, "no credential behind the edge")

    // And the production symptom row from #70's measurement table: Access
    // admits the request, then strips half the pair. An id with no secret is
    // not a credential, and a gate that starts accepting it "because the edge
    // must have checked it" has simply moved the trust to a forgeable header.
    await expectRefusedEverywhere(
      request,
      merge(EDGE, SERVICE_TOKEN_ID_ONLY),
      "client id alone behind the edge",
    )
    await expectRefusedEverywhere(
      request,
      merge(EDGE, { "CF-Access-Client-Secret": CLIENT_SECRET }),
      "client secret alone behind the edge",
    )
    await expectRefusedEverywhere(
      request,
      merge(EDGE, { "CF-Access-Client-Id": "", "CF-Access-Client-Secret": "" }),
      "empty credentials behind the edge",
    )
  })

  test("behind the edge, the plaintext header pair is not authorisation", async ({
    request,
  }) => {
    // The heart of #70. Behind the edge the pair cannot be the gate: Access
    // strips the secret it validates, so the pair the Worker sees is not
    // evidence of anything. Two consequences, and this asserts the safe one —
    //
    //   * if the Worker still *demands* the pair, a correctly-configured daemon
    //     gets a flat 401 forever (the reported bug), and
    //   * if the Worker instead *accepts* whatever pair arrives, the gate is
    //     satisfied by two headers any client can type, which is worse.
    //
    // #70 scope 3 resolves it in one direction only: behind the edge,
    // authorisation comes from a verified Access JWT. A pair is not one, so a
    // pair alone is refused, whether or not it is the "right" pair.
    await expectRefusedEverywhere(
      request,
      merge(EDGE, SERVICE_TOKEN),
      "a well-formed pair behind the edge is not a verified token",
    )

    // Constraint: "Do not weaken the local dev path into something that could
    // be reached behind the edge. `isBehindCloudflareEdge` is the only thing
    // separating them." So the local relaxation must not be re-openable by
    // anything else the client controls — the presence of the edge marker is
    // decisive on its own.
    const decoys: Headers[] = [
      { "X-Forwarded-Proto": "http" },
      { Host: "127.0.0.1:8789" },
      { "CF-Connecting-IP": "127.0.0.1" },
      { "mf-original-hostname": "127.0.0.1:8789" },
    ]
    for (const decoy of decoys) {
      await expectRefusedEverywhere(
        request,
        merge(EDGE, SERVICE_TOKEN, decoy),
        `a pair behind the edge stays refused with ${Object.keys(decoy)[0]}`,
      )
    }
  })

  test("behind the edge, a well-formed but unverifiable token is refused", async ({
    request,
  }) => {
    // #70 acceptance, clause 2, and the clause that decides whether
    // `verifyAccessIdentity()` verifies or merely decodes. Every token here is
    // a correctly-encoded JWT with the claims a real service-token assertion
    // would carry; each is wrong in exactly one way. A gate that base64-decodes
    // the payload and reads `common_name` admits all of them.
    const cases: Array<[string, string]> = [
      [
        "signed by a key no published JWKS vouches for",
        wellFormedToken(),
      ],
      [
        "signature is bytes in the right place",
        mintToken({ common_name: CLIENT_ID, forgeSignature: true }),
      ],
      [
        "alg: none, so there is nothing to verify",
        mintToken({ common_name: CLIENT_ID, alg: "none" }),
      ],
      [
        "expired an hour ago",
        mintToken({ common_name: CLIENT_ID, exp: nowSeconds() - 3600 }),
      ],
      [
        "expired one second ago",
        mintToken({ common_name: CLIENT_ID, exp: nowSeconds() - 1 }),
      ],
      [
        "issued for a different Access application (wrong aud)",
        mintToken({
          common_name: CLIENT_ID,
          aud: "0000000000000000000000000000000000000000000000000000000000000000",
        }),
      ],
      [
        "issued by a different team (wrong iss)",
        mintToken({ common_name: CLIENT_ID, iss: "https://someone-else.cloudflareaccess.com" }),
      ],
      [
        "no audience at all",
        mintToken({ common_name: CLIENT_ID, aud: [] }),
      ],
      [
        "names a service token that is not the daemon",
        mintToken({ common_name: "0000000000000000000000000000000000000000.access" }),
      ],
      ["not a JWT at all", "clearly-not-a-token"],
      ["two segments, not three", "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIifQ"],
      ["empty assertion header", ""],
      ["payload is not JSON", `${b64url('{"alg":"RS256"}')}.${b64url("not json")}.sig`],
    ]

    for (const [why, token] of cases) {
      await expectRefusedEverywhere(request, merge(EDGE, jwt(token)), why)

      // …and presenting the pair alongside it does not top it up. Two
      // insufficient credentials are not one sufficient credential.
      await expectRefusedEverywhere(
        request,
        merge(EDGE, SERVICE_TOKEN, jwt(token)),
        `${why} (with the header pair alongside)`,
      )
    }
  })

  test("behind the edge, a human's Access identity is never a bridge credential", async ({
    request,
  }) => {
    // Contract: the Service Auth application is a *third* Access application
    // scoped to `/api/bridge`, separate from the site application — "that path
    // must never widen into a general bypass". #70 changes the mechanism, not
    // that boundary: a signed-in customer, however verified, is not the daemon.
    await expectRefusedEverywhere(
      request,
      merge(EDGE, { "Cf-Access-Authenticated-User-Email": CUSTOMER_EMAIL }),
      "a customer email header behind the edge",
    )
    await expectRefusedEverywhere(
      request,
      merge(EDGE, jwt(mintToken({ email: CUSTOMER_EMAIL }))),
      "a human-identity token behind the edge",
    )
    await expectRefusedEverywhere(
      request,
      merge(
        EDGE,
        { "Cf-Access-Authenticated-User-Email": CUSTOMER_EMAIL },
        jwt(mintToken({ email: CUSTOMER_EMAIL, common_name: CLIENT_ID })),
      ),
      "a human identity claiming to be the daemon",
    )
  })

  test("behind the edge, an unfetchable key set refuses rather than admits", async ({
    request,
  }) => {
    // #70 acceptance, clause 4, and constraint 5: "An unreachable JWKS
    // endpoint, an expired token, a bad signature, a wrong audience all
    // refuse."
    //
    // The sealed run is the unreachable case by construction — README.md:
    // "no mocked bindings, no shared state between runs, no live fleet, no
    // network". Whatever URL `verifyAccessIdentity()` fetches, it does not
    // resolve here.
    //
    // TODO(test-author): neither contract.md nor #70 pins how the team domain /
    // JWKS URL is configured, so this slice cannot *induce* a fetch failure on
    // demand, only observe the one the environment already guarantees. In an
    // environment where the fetch does succeed, the token below is still
    // unverifiable (its key is generated per run and published nowhere), so the
    // required outcome is identical either way: refuse. That is the whole point
    // of failing closed — the caller cannot tell, and must not benefit.
    const token = wellFormedToken()
    await expectRefusedEverywhere(
      request,
      merge(EDGE, jwt(token)),
      "an unverifiable token with no reachable key set",
    )

    // Repeatedly. A cache is expected here (#70 scope 2: "cache it with a sane
    // TTL"), and the failure mode a cache introduces is a negative result that
    // decays into a positive one — a cached empty key set that later reads as
    // "no reason to refuse". Ten in a row, so a first-call-only check cannot
    // pass this.
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await callBridge(request, "heartbeat", merge(EDGE, jwt(token)))
      expect(res.status(), `attempt ${attempt + 1} still refuses`).toBe(401)
    }

    // And a fresh token minted after those attempts — the cache must not have
    // warmed into an admission for anything.
    await expectRefusedEverywhere(
      request,
      merge(EDGE, jwt(mintToken({ common_name: CLIENT_ID }))),
      "a freshly minted unverifiable token after repeated failures",
    )
  })

  test("a 401 behind the edge says nothing about which check fired", async ({
    request,
  }) => {
    // Contract: "401, empty body, no detail about what was wrong". #70
    // constraint 5 restates it for the new checks: "A 401 keeps its empty body
    // and says nothing about which check fired." An operator debugging the
    // daemon must not be able to distinguish "bad signature" from "wrong aud"
    // from "JWKS down" — and neither must an attacker.
    const refusals: Array<[string, Headers]> = [
      ["nothing at all", EDGE],
      ["the header pair", merge(EDGE, SERVICE_TOKEN)],
      ["the id only", merge(EDGE, SERVICE_TOKEN_ID_ONLY)],
      ["an unverifiable token", merge(EDGE, jwt(wellFormedToken()))],
      [
        "an expired token",
        merge(EDGE, jwt(mintToken({ common_name: CLIENT_ID, exp: nowSeconds() - 3600 }))),
      ],
      [
        "a forged signature",
        merge(EDGE, jwt(mintToken({ common_name: CLIENT_ID, forgeSignature: true }))),
      ],
      [
        "a wrong audience",
        merge(EDGE, jwt(mintToken({ common_name: CLIENT_ID, aud: "wrong" }))),
      ],
      ["a garbage token", merge(EDGE, jwt("clearly-not-a-token"))],
    ]

    const bodies: string[] = []
    for (const [why, headers] of refusals) {
      const res = await callBridge(request, "pull", headers)
      expect(res.status(), `${why} is 401`).toBe(401)
      const body = await res.text()
      bodies.push(body.trim())

      // Matching `15-sync-bridge.spec.ts`: an empty body and a bare `{}` are
      // both read as "empty body semantics"; anything else is detail.
      expect(["", "{}"], `${why}: 401 has empty body semantics`).toContain(body.trim())
      expect(body, `${why}: the body names no check`).not.toMatch(
        /secret|client[-_ ]?id|token|jwt|jwks|signature|audience|aud\b|issuer|expired|kid|clock|verif/i,
      )
    }

    expect(
      new Set(bodies).size,
      "every refusal behind the edge is byte-identical from outside",
    ).toBe(1)

    // TODO(test-author): response *headers* are not asserted. The contract pins
    // the body and the status only, and a `WWW-Authenticate` challenge is a
    // legitimate thing to add; it would, however, be a place for detail to leak
    // if it ever carried an `error_description`. Flagged, not pinned.
  })

  test("the local well-formed-pair path still authorises when not behind the edge", async ({
    request,
  }) => {
    // #70 scope 4, and the control that stops this slice from being satisfied
    // by a gate that simply refuses everybody. `wrangler dev`, the e2e smoke
    // net and this sealed run have no Access and no JWT in front of them; the
    // existing rule stays exactly as it is for requests that did not come
    // through the edge. If this clause ever goes red, #70's fix took the
    // daemon's development path down with it.
    const local = SERVICE_TOKEN // no CF-Ray: nothing evaluated this request before us

    const beat = await callBridge(request, "heartbeat", local)
    expect(beat.status(), "a local heartbeat with a well-formed pair is 200").toBe(200)
    expect(await beat.json()).toEqual({ ok: true })

    const pulled = await callBridge(request, "pull", local)
    expect(pulled.status(), "a local pull with a well-formed pair is 200").toBe(200)

    // TODO(test-author): a push against a submission id that does not exist has
    // no pinned outcome in the contract — only that auth is "the *only*
    // status-code-level failure in this surface". So this asserts the auth
    // claim and nothing more: whatever the body says, it is not a refusal.
    const pushed = await callBridge(request, "push", local)
    expect(pushed.status(), "a local push with a well-formed pair is not refused").not.toBe(
      401,
    )

    // A JWT is not a substitute for the pair on the local path either — the fix
    // must not add a second, softer way in that happens to be reachable without
    // the edge marker.
    await expectRefusedEverywhere(
      request,
      jwt(wellFormedToken()),
      "an unverifiable token with no pair and no edge",
    )
    await expectRefusedEverywhere(
      request,
      {},
      "no credential and no edge is still refused",
    )
  })
})
