# coord-portal

Customer intake and design sign-off portal for a `claude-coordinator` fleet. Cloudflare-hosted,
public repo, MIT. Design of record:
[`docs/CUSTOMER_PORTAL.md`](https://github.com/JDonaghy/claude-coordinator/blob/main/docs/CUSTOMER_PORTAL.md)
in the coordinator repo (milestone #23, epic #836) — read it before changing anything structural.

## The two rules that are not negotiable

**1. No customer material in git.** Intake text, design rounds, comments, mocks and screenshots live
in **D1 and R2 only**. Every fixture, seed script and E2E spec uses a **synthetic** submission. This
repo is public; a real customer's words landing in a commit cannot be taken back, and rewriting
history does not remove them from forks or caches. If you need realistic test data, invent it.

**2. The bridge is outbound-only.** The coordinator's daemon polls *this* service. Nothing here ever
initiates a connection into the tailnet — no webhook, no callback URL, no "push endpoint", not even
behind a shared secret. If latency feels bad, the answer is to poll faster, never to open a path
inward. This is the whole security argument for the portal existing on the public internet, and it is
the one thing a well-meaning change can quietly destroy.

Anything that appears to require breaking either rule is a design question for the epic, not a
judgement call to make in a PR.

## Secrets

The Cloudflare API token, account and zone ids, and any provider key live in **GitHub Actions
secrets** and `wrangler secret put`. Never in `wrangler.toml`, never in a committed `.dev.vars`,
never in a test fixture. The repo is public — assume anything committed is published permanently.

## Architecture

```
Cloudflare (public internet)              tailnet (unreachable from here)
  Pages    — static site                    coord-serve daemon
  Worker   — JSON API                         └── polls this API on its tick:
  D1       — records                              pulls submissions + sign-offs
  R2       — mock bundles, screenshots            pushes status back
  Access   — auth (no auth code in the app)
```

**Ownership is single-writer, per fact.** The portal owns customer-authored facts (submissions,
sign-offs, comments). The coordinator owns engineer-authored facts (decomposition, pipeline status).
Each side mirrors the other's read-only. Never write a field this side does not own — a two-writer
field is how you get a split-brain that no amount of retry logic fixes.

Sync is cursor-based and idempotent: stable ids, monotonic revisions, replay-safe. Assume every
request may arrive twice.

## Conventions

- TypeScript. Workers runtime (not Node) — no `fs`, no `process`, no Node built-ins unless polyfilled.
- `wrangler` for local dev and deploy; CI deploys on merge to the default branch.
- Auth is Cloudflare Access. The Worker reads the verified identity from the injected JWT and does
  **not** implement login, sessions, or password handling.
- Mocks are self-contained static HTML against a shared token stylesheet — no build step, no
  framework, no live data. This mirrors `docs/mocks/web/` in the coordinator repo.

## Testing

Three tiers, and they are not interchangeable:

| Tier | Location | Who writes it | Run with |
|---|---|---|---|
| unit | `test/` | you | `npm test` (vitest, mocked bindings) |
| smoke | `e2e/` | you | `npm run test:e2e` (real Worker, port 8788) |
| **sealed acceptance** | `tests/acceptance/` | **an independent agent** | `coord acceptance run --repo coord-portal --issue N` |

**You must never create, edit or delete anything under `tests/acceptance/`.** It is written by an
independent `test-author` agent from the milestone's Gate-A contract, before and without sight of
your implementation. That independence is the whole point: a test written against your own code
proves the code does what you made it do, not what was asked for. Editing the oracle to go green is
the one failure this pipeline exists to prevent — if a sealed test looks wrong, say so and stop;
do not "fix" it.

`coord acceptance run` prints pass/fail and failure messages only, never test source, so you can
iterate against the oracle without reading it. The coordinator then re-runs the same suite
externally against the SHA you pushed.

Behaviour-changing PRs still ship their own black-box `e2e/` coverage that drives the running app
and asserts on rendered output. Unit tests are welcome but are not the acceptance bar. Pure
refactors are exempt; say so in the PR.

**Determinism:** `npm run serve:acceptance` wipes `.wrangler/state` before migrating, so every
acceptance run starts from an empty database at schema head. Never write a test that depends on
rows another test left behind — the suite runs single-worker with no retries so that shows up as a
failure rather than as flakiness.
