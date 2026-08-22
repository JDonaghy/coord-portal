# coord-portal

Customer intake and design sign-off portal for a [`claude-coordinator`](https://github.com/JDonaghy/claude-coordinator) fleet.

A customer describes an outcome they want in plain language. Later — asynchronously, by email — they
are told a design is ready: an outcome definition, a proposed decomposition, and mocks showing the
change. They approve it or ask for changes, which opens another round. Once signed off, the work
enters the coordinator's normal pipeline and the customer follows it as a handful of human-readable
states. They never see a git branch, an issue number, or a live agent session.

**Status: v0.0.1 — skeleton.** There is no product surface yet: what exists is a deployable Worker,
a wired D1 database and R2 bucket, a health endpoint that proves all three, and the test harness.
The design is
[`docs/CUSTOMER_PORTAL.md`](https://github.com/JDonaghy/claude-coordinator/blob/main/docs/CUSTOMER_PORTAL.md)
in the coordinator repo (milestone #23, epic #836).

## How it relates to claude-coordinator

The portal is a thin client over a fleet it cannot reach. It runs on Cloudflare — Pages for the site,
Workers for the API, D1 for records, R2 for mock bundles, Access for auth — entirely on the public
internet. The coordinator runs behind a Tailscale tailnet and is not reachable from here.

They are joined by an **outbound-only sync bridge**: the coordinator's daemon polls the portal on its
existing tick, pulls new submissions and sign-offs, and pushes status back. Nothing on the internet
side ever initiates a connection inward. That is the security boundary, and it is why the portal can
be public source with no risk: it holds no credential that grants execution and has no path in.

Without a coordinator fleet on the other side, this is a form that talks to nothing. That asymmetry
is why the portal is MIT while the coordinator is FSL-1.1-MIT — the defensible part is the pipeline
this feeds, not the intake surface.

## What is in v0.0.1

| | |
|---|---|
| `src/index.ts` | one Worker: `/api/*` to the router, everything else to the static site |
| `src/routes/health.ts` | `GET /api/health` — touches D1 **and** R2, so a missing binding fails here rather than in the first feature that needs one. 503 when a probe fails. |
| `src/routes/whoami.ts` | `GET /api/whoami` — echoes the Cloudflare Access identity so the Access config can be confirmed from a browser. **Not authentication** (see below). |
| `src/routes/bridge.ts` | `/api/bridge/{pull,push,heartbeat}` — the outbound sync bridge (#15). See below. |
| `src/routes/leads.ts` | `/leads`, `/leads/:id`, `POST /leads/:id/promote` — the operator's triage inbox and the one gate a stranger's request crosses to become a submission. Operator-only; see below. |
| `src/routes/outbox.ts` | `GET /outbox` — a customer's read-back of the emails the portal decided to send them (#14). Scoped to their own sends, same as the dashboard. |
| `src/routes/deliveries.ts` | `GET /deliveries` — the operator's counterpart to `/outbox`: every outbox row, every customer, including the raw delivery error `/outbox` redacts (#55). Operator-only, same gate as `/leads`; see below. |
| `src/routes/requests.ts` | `GET /requests` — the operator's counterpart to `/submissions`: every submission, every customer, with its current design round and verdict (#104). Operator-only, same gate as `/leads`; see below. |
| `src/routes/home.ts` | `GET /` — the customer front door (#84): a signed-in customer with submissions goes straight to `/submissions`, one with none is named and pointed at `/intake`, a caller with no identity gets plain-language copy pointing at `/start`. Replaced the day-one static placeholder. |
| `migrations/` | `0001` the harness, `0002` submissions (#9), `0003` the bridge's event stream, coord mirror and daemon last-seen, `0004` question answers (#11), `0005` public leads (#31), `0006` design rounds and sign-off (#13), `0007` what a promoted lead records (#33), `0008` per-IP start attempts for the rate limit (#32), `0009` the customer outbox (#14) |
| `public/` | the token layer (`tokens.css`) shared by every server-rendered screen — no static HTML of its own since #84 |
| `test/` | 216 unit tests over routing, health probes, identity parsing, Access JWT verification and the bridge's decidable parts |
| `e2e/` | 18 Playwright specs driving the real Worker with real local D1/R2 |

**`/api/whoami` is a diagnostic, not a session.** `readAccessIdentity` reads the headers Access
injects and checks nothing, so its `verified` is hard-coded `false` and nothing may make an
authorization decision from it. The verified reading is `verifyAccessIdentity()` in the same module
(#70): JWKS-backed, RS256 signature checked, `iss` / `aud` / `exp` pinned, `null` for anything it
cannot prove. The bridge uses it; `/api/whoami` deliberately still does not, because a diagnostic
that fetches a key set is a diagnostic that can fail for a second reason.

## The sync bridge

The portal half of the outbound-only bridge (issue #15; the daemon half is coordinator #1982). Three
routes under `/api/bridge`, all JSON, **all pulled or pushed by the daemon — never called by this
side**:

| | |
|---|---|
| `GET /api/bridge/pull` | customer-authored events since an opaque `cursor` (`limit` 1–200, default 50). Ordered by a monotonic `revision`; replaying a cursor returns the same events, so a daemon outage queues rather than loses. |
| `POST /api/bridge/push` | coord-owned facts coming back. Idempotent by `(submission_id, revision)`; one result per update, in order. |
| `POST /api/bridge/heartbeat` | last-seen, so a dead daemon is distinguishable from a slow one. |

`submission_id` on the wire is the customer-visible `SUB-XXXXXX` reference, never the URL id.

**Ownership is sole-writer per fact** (`src/bridge/ownership.ts`). The portal owns `outcome`,
`audience`, `done_definition`, `constraints`, `project_scope`, `signoff_verdict`, `signoff_comment`,
`answer`; the coordinator owns `status`, `decomposition`, `question`, `design_round`, `artifacts`.
A push touching a portal-owned field is `rejected` with `reason: "not_owned:<field>"` — **at 200**,
because that is a per-item outcome in a batch, not a transport failure — and *nothing else in that
update is applied either*. Only a missing or invalid service token produces a status code (401).

**There is no fourth route, and there must never be one.** No webhook, no callback URL, no endpoint
for the daemon to register an address with — not even behind a shared secret. If latency feels bad,
the daemon polls faster. See CLAUDE.md rule 2.

### Authorising the daemon

The daemon cannot complete an interactive Access login, so it presents a **service token** as
`CF-Access-Client-Id` / `CF-Access-Client-Secret`. That needs a **fourth Access application**, scoped
to `intake.heurontech.com/api/bridge` with a **Service Auth** policy — see the Access table below.
That path authorises the bridge and nothing else; it must never widen into a general bypass.

⚠ **The Worker also checks the caller itself, and fails closed** — but *not* by comparing the
presented header pair, which behind the edge can never work. Access validates the pair and forwards
at most part of it; what it does forward is the signed `Cf-Access-Jwt-Assertion`. So in production
the Worker verifies that assertion against the team's JWKS (signature, `iss`, `aud`, `exp`) and
requires its `common_name` to be the daemon's client id (#70). Three settings, all fail-closed:

```bash
wrangler secret put BRIDGE_CLIENT_ID       # the token's Client ID — the common_name to expect
wrangler secret put ACCESS_TEAM_DOMAIN     # e.g. heurontech.cloudflareaccess.com
wrangler secret put BRIDGE_ACCESS_AUD      # the *bridge* application's AUD tag, not the site's
wrangler secret put BRIDGE_CLIENT_SECRET   # local/legacy only — see below
```

Until all three of the first are set, every request that arrives through Cloudflare's edge gets a
flat 401 no matter what Access says. That is deliberate: the alternative — trusting any well-formed
pair — turns a misconfigured or deleted Access application into a world-readable inbox of customer
submissions. `BRIDGE_CLIENT_SECRET` is **not** part of the production path any more: the edge
consumes the secret rather than forwarding it, so nothing in the Worker can compare it. It stays for
the local path and for the day Cloudflare forwards both halves.

Locally there is no edge, no Access and no JWT, so `wrangler dev` honours any well-formed pair
exactly as before; the Worker tells the two apart by `CF-Ray`, which only the edge can set
(`src/deployment.ts`), and a client who forges one lands in the *stricter* branch. It cannot use the
hostname: `wrangler dev` serves the custom domain from a laptop.

**If the daemon is still getting a 401**, the Worker leaves one line in `wrangler tail` per refusal
behind the edge — which credential headers arrived, which claims a verified token carried (names
only, never values), and which of the three settings are unset. That is the measurement this bug
cost us: the 401 is silent to the caller on purpose, so the diagnosis lives in the log.

The AUD tag comes from the Access application's own page (Cloudflare dashboard → Access →
Applications → the bridge application → *Application Audience (AUD) Tag*). It is per-application:
using the site application's tag would let a signed-in human's token be replayed at the bridge,
which is exactly what pinning `aud` prevents.

## Development

```bash
npm install
npm run db:migrate:local      # apply migrations to the local D1
npm run dev                   # http://localhost:8787
npm run typecheck             # tsc over src+test and over e2e
npm test                      # vitest — fast, mocked bindings
npm run test:e2e              # playwright — real Worker, real local D1/R2
```

Everything above works offline with no Cloudflare account. `wrangler dev` runs the Worker in
miniflare with local D1 and R2, which is why the e2e suite is the acceptance bar rather than a
mock-heavy unit layer.

## Deployment

**Live at https://intake.heurontech.com** (since 2026-08-08). Merges to `main` deploy
automatically: `.github/workflows/deploy.yml` applies D1 migrations, runs `wrangler deploy`, then
polls `/api/health` until it reports `ok` — so a deploy that lands broken fails the run rather than
sitting there green.

`*.workers.dev` is **disabled** (`workers_dev = false`). It is not tidiness: Access protects a
hostname, so a live workers.dev URL would be a second, unprotected front door to the same Worker.
That setting and the route in `wrangler.toml` must always change together.

The apex `heurontech.com` is a **separate, untouched site** — GitHub Pages, grey-cloud, plus Zoho
mail. Only `intake` is proxied. Nothing here should ever need an apex DNS change; if a task seems to,
that is a signal to stop and re-read this paragraph.

### Cloudflare account setup

- [x] `wrangler login`, D1 `coord-portal` (ENAM), R2 `coord-portal-artifacts`
      — note R2 must be **enabled in the dashboard** before a bucket can be created; D1 needs no
      such step
- [x] Migrations applied remotely; `wrangler deploy`
- [x] **DNS** — `heurontech.com` zone moved to Cloudflare (registrar stays Hostinger). Apex A
      records, `www`, three Zoho MX and the verification TXT all replicated and **grey-cloud**.
      Cloudflare's importer defaults A/CNAME records to *proxied* — they had to be set back to DNS
      only, or the apex site would have gone behind the proxy on activation.
- [x] `intake.heurontech.com` as a Worker custom domain (proxied — a route only fires on a proxied
      record)
- [x] **Cloudflare Access** — two applications, see below (team domain
      `heurontech.cloudflareaccess.com`)
- [x] Repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, plus repo variable
      `PORTAL_URL`

**Token scope** (least privilege that actually works): Account → Workers Scripts **Edit**, D1
**Edit**, Workers R2 Storage **Read**, Account Settings **Read**; Zone → Workers Routes **Edit**,
scoped to `heurontech.com` only. That last one is required by the custom domain — without it
`wrangler deploy` uploads the Worker and then fails registering the route.

### Access

Configured 2026-08-08. Team domain `heurontech.cloudflareaccess.com`; login by one-time PIN.

Four applications, not one — Cloudflare matches most-specific-first:

| Application | Path | Policy |
|---|---|---|
| `intake.heurontech.com/api/health` | health only | **Bypass** — everyone |
| `intake.heurontech.com/start` | the public lead form (issue #31) | **Bypass** — everyone |
| `intake.heurontech.com/api/bridge` | the sync bridge only | **Service Auth** — the daemon's service token |
| `intake.heurontech.com` | everything else | **Allow** — permitted emails |

The bridge application was created 2026-08-13 alongside the `coord-daemon` service token. Its **AUD
tag** is what `BRIDGE_ACCESS_AUD` must hold; the site application's tag is a different value and
using it would defeat the point of pinning `aud`.

The `/start` bypass is an **account-setup step, same as the bridge application above — not yet
created**. The Worker itself never authenticates that route (`src/routes/start.ts` never reads an
Access identity), but until the dashboard policy exists, Access's own edge still intercepts the
path in production and shows a login page before the Worker ever sees the request. Local dev,
`wrangler dev`, and every test tier in this repo have no Access in front of them at all, so they
exercise the route as public today regardless of this policy's state — only the live deployment
needs it.

The `/api/health` bypass is **required, not a convenience**: without it CI's post-deploy health
check receives a login page and every deploy fails. Health exposes a version and a schema version,
nothing about any customer.

For **everything except `/api/bridge`, Access is still the only control** — deleting or
misconfiguring that policy silently reopens the site, because the Worker does not verify the
assertion on those routes and cannot tell a genuine Access request from a forged one. `/api/bridge`
is the exception as of #70: it verifies, so a deleted Access application closes the bridge rather
than opening it. See `src/identity.ts`.

### The operator surface, and the seat that is issued by hand

`/leads` is the operator's triage inbox: every lead the public form has taken, and the one action
that turns one into a customer. `/deliveries` (#55) is the same kind of screen for a different job:
every outbox row across every customer, the operator's counterpart to the customer-scoped `/outbox`,
including the raw provider error a stuck send left behind — the one field `/outbox` never shows.
`/requests` (#104) rounds the set out: every submission across every customer, the operator's
counterpart to the customer-scoped `/submissions`, including the current design round and its
verdict — the gap that opened the moment a promoted lead's own submission became invisible to the
operator who promoted it. All three sit behind the same site-wide Allow policy as everything else —
there is no fifth Access application — and the Worker additionally checks the Access identity
against one allowlist shared by all three routes:

```bash
wrangler secret put OPERATOR_EMAILS   # comma- or whitespace-separated addresses
```

**Unset means nobody**, in production: `/leads`, `/deliveries` and `/requests` are all a 404 for
every caller, including whoever deployed it. That is the same fail-closed position the bridge's
service token takes, and for the same reason — a deploy that forgets the setting should have no
operator surface at all rather than one that answers to whatever address the Allow policy happens to
admit. A caller who is not on the list gets exactly the response a missing lead gets: a 404, never a
403, so nobody who guesses the URL learns any of the three surfaces exist. `wrangler dev` and every
test tier honour a single synthetic development operator instead — see `src/operators.ts`.

**Promotion does not issue the Access seat.** Nothing in this application can add an address to an
Access policy, and nothing should: the thing that grants access to customer data must not be
reachable from the application that serves it. So after promoting a lead, add that customer's email
to the site's Allow policy **by hand** — the screen says so, in the flow, and names the exact
address. Skipping it produces the worst available failure: a customer who was accepted, never told,
and whose sign-in either bounces at the edge or lands them in an empty portal under a different
identity. Neither shows an error to anybody.

That address is load-bearing beyond the policy: every authenticated screen is scoped by the email
Access returns, so the address entered at promotion **is** the customer's identity. One-time PIN
cannot fragment it — the inbox that receives the PIN is the identity — but a federated provider
returns whatever address that account carries, which may not be the one that was typed in.

**Verifying a policy change did what you meant.** Checking that `/api/health` still answers proves
nothing about the rest — a bypass mistakenly scoped to `api` instead of `api/health` leaves every
API route public while health looks identical. Check a path that must be *closed*:

```bash
curl -sS -o /dev/null -w "%{http_code} %{url_effective}\n" -L https://intake.heurontech.com/api/whoami
# must land on heurontech.cloudflareaccess.com/cdn-cgi/access/login/...
curl -sS https://intake.heurontech.com/ | grep -c "coord-portal"    # must be 0

# and the bridge, which must answer nobody without a service token
curl -sS -o /dev/null -w "%{http_code}\n" https://intake.heurontech.com/api/bridge/pull
# 401 from the Worker, or an Access login redirect — never 200, never a JSON event list
```

`Deploy` triggers on `push: main` and `workflow_dispatch` **only — never `pull_request`**, so a fork
PR cannot reach the token. Do not add one.

The deploy workflow **skips itself** while `CLOUDFLARE_API_TOKEN` is unset — the guard is its own
job, so an unconfigured repo records no deployment at all rather than a `production / success` that
never happened.

## Contributing

See [`CLAUDE.md`](CLAUDE.md) for the rules that apply to any change here — in particular that **no
customer material may be committed to this repo**, and that **the sync bridge is outbound-only**.

## License

MIT. See [`LICENSE`](LICENSE).
