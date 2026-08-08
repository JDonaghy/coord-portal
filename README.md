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

### Cloudflare account setup

Not done yet — the repo is deliberately deployable-once-configured rather than half-deployed. The
steps, in order:

1. `npx wrangler login`
2. `npx wrangler d1 create coord-portal` → paste the returned `database_id` into `wrangler.toml`
   (it is an account-scoped identifier, not a secret)
3. `npx wrangler r2 bucket create coord-portal-artifacts`
4. `npx wrangler d1 migrations apply coord-portal --remote`
5. `npx wrangler deploy`
6. Point a `heurontech.com` subdomain at the Worker (Cloudflare DNS → Workers Routes)
7. Put **Cloudflare Access** in front of the hostname — until that is done the site is public
8. Repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and repo variable `PORTAL_URL`,
   so `.github/workflows/deploy.yml` starts deploying on merge to `main`

The deploy workflow **skips itself** while `CLOUDFLARE_API_TOKEN` is unset, so `main` stays green
until step 8. It applies migrations before deploying and then checks `/api/health` reports `ok`.

## Contributing

See [`CLAUDE.md`](CLAUDE.md) for the rules that apply to any change here — in particular that **no
customer material may be committed to this repo**, and that **the sync bridge is outbound-only**.

## License

MIT. See [`LICENSE`](LICENSE).
