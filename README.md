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
| `migrations/0001_init.sql` | the migration harness. Deliberately *not* the record model — that is #830. |
| `public/` | placeholder page with a live health readout, and the token layer |
| `test/` | 20 unit tests over routing, health probes and identity parsing |
| `e2e/` | 8 Playwright specs driving the real Worker with real local D1/R2 |

**`/api/whoami` is a diagnostic, not a session.** It reads the headers Access injects but does not
verify the JWT against the team JWKS, so `verified` is hard-coded `false` and nothing may make an
authorization decision from it. Verification is #1981; the shape is there so that lands additively.

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

**Live at https://coord-portal.johnfdonaghy.workers.dev** (since 2026-08-08). Merges to `main`
deploy automatically: `.github/workflows/deploy.yml` applies D1 migrations, runs `wrangler deploy`,
then polls `/api/health` until it reports `ok` — so a deploy that lands broken fails the run rather
than sitting there green.

> **⚠️ It is public and unauthenticated.** There is no Cloudflare Access in front of it yet, so
> anyone with the URL can read the landing page and `/api/health`. That is acceptable for a version
> string and a schema number. **It stops being acceptable the moment anything stores a customer's
> words** — Access (step 7 below) must land before the design-round work in #1983.

### Cloudflare account setup

Done, except DNS and Access:

- [x] `npx wrangler login`
- [x] `npx wrangler d1 create coord-portal` — `database_id` is in `wrangler.toml` (an
      account-scoped identifier, not a secret)
- [x] `npx wrangler r2 bucket create coord-portal-artifacts` — note R2 must be **enabled** in the
      dashboard first, which D1 does not require
- [x] `npx wrangler d1 migrations apply coord-portal --remote`
- [x] `npx wrangler deploy`
- [ ] **DNS** — point a `heurontech.com` subdomain at the Worker. Requires moving the zone to
      Cloudflare: Access only works on a Cloudflare zone, and per-subdomain (CNAME) delegation is a
      Business-plan feature.
- [ ] **Cloudflare Access** in front of the hostname. **Set `workers_dev = false` in the same
      change** — otherwise the `*.workers.dev` URL stays reachable and bypasses Access entirely.
- [x] Repo secrets `CLOUDFLARE_API_TOKEN` (scoped: Workers Scripts edit, D1 edit, R2 read, Account
      Settings read) and `CLOUDFLARE_ACCOUNT_ID`, plus repo variable `PORTAL_URL`

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
