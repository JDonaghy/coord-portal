# tests/acceptance — the sealed oracle

**If you are a worker implementing an issue: you may run these, and you may not edit them.**

Everything under this directory is written by an **independent `test-author` agent** from the
milestone's Gate-A contract (`ms-NN/contract.md`), before — and without sight of — the
implementation. That independence is the entire value: a test you wrote against your own code
proves the code does what you made it do, which is not the same as what was asked for.

Check yourself against it with:

```bash
coord acceptance run --repo coord-portal --issue <N>
```

That prints pass/fail and failure messages only, never test source. You iterate against the
oracle without reading it. The coordinator then re-runs the same suite **externally**, against the
exact SHA you pushed, in a worktree you never touch — which is the gate that actually counts,
because a headless session can claim green and cannot fake that.

Your own unit tests are welcome and belong in `test/` (vitest) or `e2e/` (the Playwright smoke
net). Neither is a substitute for this, and neither is sealed.

## Layout

```
tests/acceptance/
  ms-1/
    contract.md      ← Gate-A: the black-box contract, mock-first
    mocks/           ← the viewable surface the contract describes
    *.spec.ts        ← the sealed suite, one slice per issue
```

## Determinism

`npm run serve:acceptance` deletes `.wrangler/state` before applying migrations, so every run
starts from an empty database at schema head, then boots the real Worker over it. No mocked
bindings, no shared state between runs, no live fleet, no network.

This is why coord-portal can host a sealed oracle today: `wrangler dev` over a freshly-migrated
local D1 already *is* the deterministic backend that other repos have to build first. Do not add a
test that depends on rows another test wrote — the suite runs with `workers: 1` and no retries
precisely so that ordering dependency shows up as a failure rather than as flakiness.

## Why an empty slice is not a pass

Playwright exits **0 with 0 tests** when a filter matches nothing. `coord.acceptance.build_verdict`
treats a zero-test result as **not green** for exactly that reason. If a slice reports zero tests,
the wiring is broken — that is never "the feature is fine".
