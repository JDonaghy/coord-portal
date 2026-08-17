# Cloudflare configuration for coord-portal

Everything the portal needs from Cloudflare, and the traps that cost real time
the first time round. Written 2026-08-15, after getting the whole chain working
end to end for the first real customer.

**This repo is public.** No secret values appear below — only the *names* of
secrets and where to find each one. Keep it that way.

Assumed context: the portal is a Cloudflare **Worker** (D1 + R2) deployed with
`wrangler`, served at a custom hostname, and sitting behind **Cloudflare
Access**. `coord` (the fleet coordinator) talks to it from outside as a machine
client. Customers reach it as humans with no account of any kind.

---

## The five-minute mental model

Three parties touch this system and each authenticates differently:

| party | how it proves itself | what it may reach |
|---|---|---|
| a stranger on the internet | nothing | `/start` only |
| a customer | Access, one-time PIN to their email | `/submissions/…` they own |
| the coord daemon | Access **service token** | `/api/bridge/*` |

Access sits in front of everything, so "which application is this request
hitting" decides which of those three rules applies. That is why there are
several Access applications rather than one.

---

## The Access applications

Four, each scoped to a path. **They are separate applications, not policies on
one application.**

| application | scope | type |
|---|---|---|
| site | the hostname | Allow, by email |
| health | `/api/health` | **Bypass** |
| lead intake | `/start` | **Bypass** |
| bridge | `/api/bridge` | **Service Auth** |

Notes that matter:

- **The health Bypass is required, not optional.** Deploys and monitoring hit
  `/api/health` unauthenticated. Remove that app and deploys start failing in a
  way that looks nothing like an auth problem.
- **`/start` is deliberately public** — it is the front door for a stranger who
  has never heard of you. Everything it can reach is designed on that
  assumption.
- **Each application has its own AUD tag.** The site's and the bridge's are
  different values, and using the site's where the bridge's belongs would let a
  signed-in human's token be replayed against the machine API. Copy each from
  its own application page in the dashboard; never assume they are shared.

A policy is a separate object from an application, and **a policy that is not
attached to an application gates nothing**. If a policy page says
`Used by applications: --`, it is inert no matter how correct its rules look.

---

## The header trust asymmetry — read this before debugging any 401

This is the single most expensive thing to rediscover, and it is not
documented anywhere obvious.

**Cloudflare Access strips the credentials it validates.** After the edge
authenticates a request, it removes:

- `CF-Access-Client-Secret` (service tokens)
- `Cf-Access-Authenticated-User-Email`

and forwards only:

- **`Cf-Access-Jwt-Assertion`** — a signed JWT that survives untouched.

So any Worker-side check of the form "does the presented secret equal the
expected secret" can **never** pass in production, no matter how correct the
values are. It works locally with `wrangler dev` (no edge in the path) and
fails in production forever. That was this repo's issue #70, and it presented as
a flat, silent 401 that looked exactly like a misconfigured token.

The correct check is to verify the JWT: fetch the JWKS, cache it, verify the
signature, then check the audience and the identity claim.

- JWKS lives at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
- For a **human**, the identity claim is `email`
- For a **service token**, it is `common_name` — which carries the client *id*,
  not the secret

Diagnostic shortcut when a 401 persists: **`wrangler tail` prints one line per
edge refusal naming which settings are unset.** The 401 is deliberately silent
to the caller, so guessing is worse than useless — read the tail.

A quick way to tell who refused you:

| response | who answered |
|---|---|
| **403** | Cloudflare Access — the credential or policy is wrong |
| **401** | your Worker — Access let it through and the app said no |

---

## Worker secrets

Set with `wrangler secret put NAME`. Never in git.

| name | what it is |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com`. **Verify any guess** by curling its `/cdn-cgi/access/certs` — a 200 with keys means real, a 404 means wrong. Shared by both verified paths below — it names the *team*, not an application |
| `BRIDGE_ACCESS_AUD` | the **bridge** application's AUD tag, from that application's own page |
| `SITE_ACCESS_AUD` | the **site** application's AUD tag (issue #108/#1981) — gates every customer- and operator-facing route (`src/identity.ts`'s `resolveSiteIdentity`). Never the same value as `BRIDGE_ACCESS_AUD` — see "Each application has its own AUD tag" above |
| `BRIDGE_CLIENT_ID` | the service token's client id — the `common_name` the JWT will carry |
| `BRIDGE_CLIENT_SECRET` | only used by the local `wrangler dev` path; the edge consumes it in production |
| `RESEND_API_KEY` | transactional mail |
| `TURNSTILE_*` | bot gate on the public form |
| `OPERATOR_EMAILS` | who sees operator surfaces |

The bridge fails **closed**: miss any one of `ACCESS_TEAM_DOMAIN`,
`BRIDGE_ACCESS_AUD` or `BRIDGE_CLIENT_ID` and it returns the same flat 401 as a
genuine auth failure. If the bridge 401s right after a deploy, check that all
three are set *before* suspecting the code.

Every customer- and operator-facing route fails the same way on
`ACCESS_TEAM_DOMAIN` or `SITE_ACCESS_AUD`: miss either behind the edge and the
whole site refuses everyone, including you, with the same flat 401 — not a
crash, and not a route that quietly falls back to trusting an unverified
claim. Set both *before* reporting the portal as broken after a fresh deploy.

---

## Login methods — the customer cannot sign in without this

By default the only identity provider may be Cloudflare's own, which means
signing in **requires a Cloudflare account**. A customer will not have one, and
the login screen gives no hint that this is the problem.

Add **One-time PIN**. It emails the visitor a code and needs no credentials, no
OAuth app, no callback URL — adding it *is* configuring it.

**Where it lives: `Integrations → Identity providers` → Add new → One-time
PIN.** Not under "Access settings", which has App Launcher / session duration /
MFA and no login methods at all. This is the single hardest page to find in the
whole setup.

Two things that look relevant and are not:

- **"Restrict to account members"** on the Cloudflare provider. Turning it off
  still requires the visitor to have a Cloudflare account. It is not the
  blocker; leave it on.
- **The team domain printed on the login page may be a stale legacy name** (the
  auto-generated `adjective-noun-1234` one) if the team was ever renamed. Trust
  the JWKS endpoint, not the page: whichever domain serves keys is the live one.

---

## Onboarding a customer — the manual step

**The portal cannot add a customer to Access.** It says so in its own UI when
you promote a lead. Until it is automated, a human adds the customer's email to
the site application's policy by hand.

Get the address from the `To:` header of the notification the portal actually
sent. Do not retype it from memory — a single wrong character produces a login
that fails with no useful message, and the failure looks identical to a broken
Access configuration.

---

## Mail

Sending is Resend, from a **subdomain** (`mail.<domain>`) so transactional
reputation stays isolated from human mail.

- SPF for the envelope lives on `send.mail.<domain>` (`include:amazonses.com`)
- DKIM at `resend._domainkey.mail.<domain>`
- DMARC on **both** the apex and the `mail.` subdomain — the org-domain fallback
  covers the subdomain in principle, but checkers look for the exact name
- Never use strict SPF alignment (`aspf=s`): the envelope domain and the From
  domain differ by design, so strict alignment breaks sending permanently. DKIM
  aligns exactly, so DMARC still passes.

### ⚠ The MX records on `mail.<domain>` are load-bearing

If Email Routing forwards a mailbox on that subdomain, its
`route*.mx.cloudflare.net` MX records are **managed records serving that
forward**. They render padlocked and read-only, which looks like leftover junk
from an abandoned experiment. It is not. Deleting them means disabling Email
Routing, which destroys the forward with it.

And the trap sits in the same screen you have to visit: **Email Routing is
scoped to the zone, not the hostname.** Its dashboard will flag your real MX
records as "Conflicting", list Cloudflare's own as "Missing", and offer a
one-click fix. **Never accept it** — it replaces the apex MX and takes down all
inbound mail for the domain.

Test the forward before believing any claim, in code comments or anywhere else,
about whether an address receives mail. A stale comment claiming "this address
receives nothing" is how a working reply path nearly got deleted here.

---

## The coord side

`coordinator.yml` (in the coord-settings checkout, not this repo):

```yaml
portal:
  enabled: true                              # also arms the daemon sync loop
  base_url: "https://<host>"
  bridge_client_id: "${BRIDGE_CLIENT_ID}"
  bridge_client_secret: "${BRIDGE_CLIENT_SECRET}"
```

`${...}` interpolates from the **daemon process environment**, which a config
hot-reload does not refresh. On a systemd host:

- put the values in `~/.coord/coord-serve.env`, `chmod 600`
- reference it from a drop-in, `coord-serve.service.d/10-portal-env.conf`:

  ```ini
  [Service]
  EnvironmentFile=-%h/.coord/coord-serve.env
  ```

- **the leading `-` is load-bearing** — without it, a missing file stops the
  whole board daemon from starting
- a **restart** is required; config hot-reload does not pick up new env

`COORD_PORTAL_SYNC_INTERVAL` controls the outbound loop (default 60s, `0`
disables). The bridge is **outbound only** and stays that way: an inbound
webhook would hand the public internet a path into the tailnet.

---

## Verify, in this order

Each step only makes sense if the previous one passed.

1. `curl https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` → 200 + keys
2. `curl https://<host>/api/health` → 200 without any credentials (proves the
   Bypass app exists)
3. `coord portal status` → configuration is loaded
4. `coord portal heartbeat` → `heartbeat sent` (proves the whole bridge path:
   token → edge → JWT → JWKS → Worker)
5. `coord portal sync` → one loop pass by hand
6. Sign in as a customer in a real browser, from the bare hostname

Step 6 is not optional. Steps 1–5 all passed here while customers still could
not log in, because none of them exercise the login-methods configuration.

---

## Traps, collected

- A Worker-side comparison against `CF-Access-Client-Secret` can never pass in
  production. The edge strips it.
- 403 is Access; 401 is your Worker. They mean different things.
- Each Access application has its own AUD. Do not share one between apps.
- A policy not attached to an application gates nothing.
- One-time PIN lives under **Integrations → Identity providers**, not Access
  settings.
- The team domain on the login page can be stale; the JWKS endpoint is the
  authority.
- `route*.mx.cloudflare.net` records on the mail subdomain are load-bearing.
- Email Routing's "fix the conflicting records" prompt will take down your
  apex MX.
- `${VAR}` in `coordinator.yml` needs a daemon **restart**, not a reload.
- A submission has two handles: the customer-facing URL uses the row's `id`
  (`sub_…`), while `coord portal push` takes its `reference` (`SUB-…`). They are
  not interchangeable and the operator only ever sees the second one.
