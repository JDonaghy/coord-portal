/** Shared HTML rendering for the server-rendered portal pages (not /api/*). */

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set("content-type", "text/html; charset=utf-8")
  return new Response(body, { ...init, headers })
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export type NavCurrent = "dashboard" | "new" | "none"

/**
 * The header every authenticated screen carries, per the contract's global
 * hook list: `brand-home`, `nav-dashboard`, `nav-new`, `identity-email`.
 *
 * `email` is deliberately not asserted as verified here or anywhere else —
 * see `src/identity.ts`. It is display copy, not an authorization decision.
 */
export function topbar(email: string | null, current: NavCurrent): string {
  const dashboardCurrent = current === "dashboard" ? ' aria-current="page"' : ""
  const newCurrent = current === "new" ? ' aria-current="page"' : ""
  const identity = email ? escapeHtml(email) : "unknown"

  return `<header class="topbar">
  <a class="brand" href="/" data-testid="brand-home">coord-portal</a>
  <nav aria-label="primary">
    <a href="/submissions" data-testid="nav-dashboard"${dashboardCurrent}>My requests</a>
    <a href="/intake" data-testid="nav-new"${newCurrent}>New request</a>
  </nav>
  <span class="identity" data-testid="identity-email">signed in as ${identity}</span>
</header>`
}

/**
 * The header every UNauthenticated public screen carries — issue #31's
 * `/start`. Deliberately not `topbar()`: no nav, no identity, because there is
 * no signed-in customer to name and no dashboard for a stranger to reach.
 * Reusing `topbar()` even for a signed-in caller who happens to hit `/start`
 * would leak that they're "signed in" as someone — see the Gate-A contract's
 * "`01`, `02`, `03` all share: `brand-home` in a header that carries nothing
 * else."
 */
export function publicHeader(): string {
  return `<header class="topbar">
  <a class="brand" href="/" data-testid="brand-home">coord-portal</a>
</header>`
}

/** Wraps a `<main>` body in the shared document shell and token stylesheet. */
export function page(title: string, main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/tokens.css">
<style>
  header.topbar {
    display: flex; align-items: center; gap: 1.25rem;
    max-width: 44rem; margin: 0 auto 2rem; padding-bottom: 1rem;
    border-bottom: 1px solid var(--line);
  }
  header.topbar .brand { font-weight: 700; color: var(--text); text-decoration: none; font-size: var(--step-1); }
  header.topbar nav { display: flex; gap: 1rem; margin-right: auto; }
  header.topbar nav a { color: var(--text-dim); text-decoration: none; font-size: var(--step--1); }
  header.topbar nav a[aria-current="page"] { color: var(--accent); font-weight: 600; }
  header.topbar .identity { color: var(--text-faint); font-size: var(--step--1); font-family: var(--font-mono); }
  main { max-width: 44rem; margin: 0 auto; padding: 0 1rem 3rem; }

  form.intake, form.lead { display: grid; gap: 1.25rem; }
  .field { display: grid; gap: 0.4rem; }
  .field label { font-weight: 600; font-size: var(--step--1); color: var(--text); }
  .field .hint { color: var(--text-faint); font-size: var(--step--1); font-weight: 400; }
  .field textarea, .field input[type="text"] {
    font: inherit; padding: 0.65rem 0.75rem; border-radius: var(--r-md);
    border: 1px solid var(--line-strong); background: var(--surface); color: var(--text);
    resize: vertical;
  }
  .field textarea:focus, .field input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .optional-tag {
    font-size: var(--step--1); color: var(--text-faint); font-weight: 400;
    border: 1px solid var(--line); border-radius: 999px; padding: 0 0.5em; margin-left: 0.5em;
  }
  .actions { display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 0.5rem; }
  button.primary {
    background: var(--accent); color: white; border: none; border-radius: var(--r-md);
    padding: 0.65rem 1.25rem; font: inherit; font-weight: 600; cursor: pointer;
  }
  button.primary:hover { background: var(--accent-dim); }
  .async-note {
    background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-md);
    padding: 0.85rem 1rem; font-size: var(--step--1); color: var(--text-dim); margin-bottom: 1.5rem;
  }
  .lead-error {
    background: var(--fail-wash); color: var(--fail); border: 1px solid var(--fail);
    border-radius: var(--r-md); padding: 0.85rem 1rem; font-size: var(--step--1);
    margin-bottom: 1.5rem; font-weight: 600;
  }

  .status-pill {
    display: inline-flex; align-items: center; gap: 0.4em;
    padding: 0.25em 0.75em; border-radius: 999px;
    font-size: var(--step--1); font-weight: 600;
  }
  .status-pill[data-status="describing"] { background: var(--idle-wash); color: var(--idle); }

  .receipt { text-align: center; padding: 2rem 1rem; }
  .receipt .ref {
    font-family: var(--font-mono); color: var(--text-faint); font-size: var(--step--1);
    margin: 0.5rem 0 1.5rem;
  }
  .receipt h1 { margin-bottom: 0.5rem; }
  .receipt p.lede { max-width: 32rem; margin: 0 auto 2rem; }
  .receipt .actions { display: flex; justify-content: center; gap: 0.75rem; }
  a.button {
    display: inline-block; text-decoration: none; border-radius: var(--r-md);
    padding: 0.6rem 1.1rem; font-weight: 600; font-size: var(--step--1);
  }
  a.button.primary { background: var(--accent); color: white; }
  a.button.secondary { border: 1px solid var(--line-strong); color: var(--text); }

  .page-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 1.5rem; }
  ul.submission-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
  .submission-row {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    text-decoration: none; color: inherit;
    background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg);
    padding: 1rem 1.25rem;
  }
  .submission-row:hover { border-color: var(--line-strong); }
  .submission-row .title { font-weight: 600; }
  .submission-row .meta { color: var(--text-faint); font-size: var(--step--1); font-family: var(--font-mono); }
  .row-main { display: grid; gap: 0.2rem; }

  .status-pill[data-status="in-design"]        { background: var(--accent-wash); color: var(--accent-dim); }
  .status-pill[data-status="awaiting-signoff"] { background: var(--attn-wash);   color: var(--attn); }
  .status-pill[data-status="planned"]          { background: var(--idle-wash);   color: var(--idle); }
  .status-pill[data-status="in-progress"]      { background: var(--accent-wash); color: var(--accent-dim); }
  .status-pill[data-status="quality-check"]    { background: var(--accent-wash); color: var(--accent-dim); }
  .status-pill[data-status="needs-input"]      { background: var(--attn-wash);   color: var(--attn); }
  .status-pill[data-status="shipped"]          { background: var(--pass-wash);   color: var(--pass); }
  .status-pill[data-status="on-hold"]          { background: var(--idle-wash);   color: var(--idle); }

  .back-link { font-size: var(--step--1); display: inline-block; margin-bottom: 1rem; }

  main[data-testid="submission-detail"] .meta {
    color: var(--text-faint); font-size: var(--step--1); font-family: var(--font-mono); margin: 0.35rem 0 1.5rem;
  }
  main[data-testid="submission-detail"] .card {
    background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 1.25rem;
  }
  ol.timeline {
    list-style: none; margin: 0 0 2rem; padding: 0; display: flex; flex-wrap: wrap; gap: 0 0.5rem;
  }
  ol.timeline li {
    font-size: var(--step--1); color: var(--text-faint); padding: 0.3em 0; position: relative;
  }
  ol.timeline li:not(:last-child)::after { content: "→"; margin: 0 0.5em; color: var(--line-strong); }
  ol.timeline li[data-current="true"] { color: var(--accent-dim); font-weight: 700; }
  .provisional-flag {
    border: 1px dashed var(--line-strong); color: var(--text-faint); font-size: var(--step--1);
    border-radius: var(--r-md); padding: 0.6rem 0.85rem; margin-top: 1rem;
  }

  .pause-banner {
    background: var(--attn-wash); color: var(--attn); font-weight: 600;
    border: 1px solid var(--attn); border-radius: var(--r-md);
    padding: 0.75rem 1rem; margin-bottom: 1.25rem;
  }
  .question-thread .question-text { white-space: pre-wrap; margin: 0 0 1.25rem; }
  .answer-form textarea { width: 100%; }

  /* ── The design round and its sign-off loop (issue #13) ──────────────────
     mocks/05-submission-awaiting-signoff.html, 06-request-changes.html and
     07-round-history.html.

     The composer opens with no JavaScript: .composer-toggle is a
     visually-hidden checkbox that sits ahead of both the round card and the
     composer, and the two label[role=button] controls (request-changes-button,
     cancel-changes) toggle it. Everything below is the sibling-selector
     consequence of that one checkbox. Do not replace this with a script — "no
     build step, no framework" (CLAUDE.md), and every other control on this
     portal already works without one. */
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  .composer-toggle { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }

  .round-card {
    background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 1.5rem;
  }
  .round-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
  .round-badge {
    font-family: var(--font-mono); font-size: var(--step--1); color: var(--text-dim);
    background: var(--surface-2); border-radius: 999px; padding: 0.2em 0.7em;
  }
  .round-history-link { font-size: var(--step--1); }
  .round-history-aside { font-size: var(--step--1); margin-top: 1.5rem; }
  .round-card h2 {
    font-size: var(--step-0); text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-dim); margin: 1.25rem 0 0.5rem;
  }
  .round-card h2:first-of-type { margin-top: 0; }
  .outcome-definition { white-space: pre-line; }
  ul.decomposition-list { margin: 0; padding-left: 1.25rem; display: grid; gap: 0.4rem; }
  .mock-bundle-link {
    display: inline-flex; align-items: center; gap: 0.5em; margin-top: 0.5rem;
    color: var(--accent); text-decoration: none; font-weight: 600; font-size: var(--step--1);
  }
  .round-actions { display: flex; gap: 0.75rem; margin-top: 1.75rem; align-items: center; }
  .round-actions form.inline-form { margin: 0; }
  .round-actions button.primary { background: var(--pass); }
  .round-actions button.primary:hover { background: var(--pass); filter: brightness(0.92); }
  label.secondary, label.ghost {
    display: inline-block; border-radius: var(--r-md); padding: 0.65rem 1.25rem;
    font-weight: 600; font-size: inherit; cursor: pointer; user-select: none;
  }
  label.secondary { background: var(--surface); color: var(--text); border: 1px solid var(--line-strong); }
  label.ghost { background: transparent; color: var(--text-dim); border: 1px solid var(--line-strong); }
  label.secondary:focus-visible, label.ghost:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  form.composer { display: none; }
  .composer-toggle:checked ~ form.composer { display: block; }
  .composer-toggle:checked ~ .round-card { opacity: 0.55; }
  .composer-toggle:checked ~ .round-card .round-actions { display: none; }
  form.composer {
    background: var(--surface); border: 1px solid var(--attn); border-radius: var(--r-lg);
    padding: 1.5rem; margin-top: 1rem; box-shadow: 0 4px 20px rgba(0,0,0,0.06);
  }
  form.composer h2 { margin-top: 0; font-size: var(--step-1); }
  form.composer .hint { color: var(--text-dim); font-size: var(--step--1); margin-bottom: 1rem; }
  form.composer textarea {
    width: 100%; font: inherit; padding: 0.65rem 0.75rem; border-radius: var(--r-md);
    border: 1px solid var(--line-strong); background: var(--ground); color: var(--text); resize: vertical;
  }
  form.composer .actions { display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1rem; }
  form.composer button.primary { background: var(--attn); }
  .next-round-note { font-size: var(--step--1); color: var(--text-faint); margin-top: 0.75rem; }
  .composer-error {
    background: var(--fail-wash); color: var(--fail); border: 1px solid var(--fail);
    border-radius: var(--r-md); padding: 0.75rem 1rem; font-size: var(--step--1);
    font-weight: 600; margin-bottom: 1rem;
  }

  .round-entry {
    background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg);
    padding: 1.25rem 1.5rem; margin-bottom: 1rem;
  }
  .round-entry-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; }
  .verdict-pill { font-size: var(--step--1); font-weight: 600; padding: 0.2em 0.7em; border-radius: 999px; }
  .verdict-pill[data-verdict="changes-requested"] { background: var(--fail-wash); color: var(--fail); }
  .verdict-pill[data-verdict="approved"]          { background: var(--pass-wash); color: var(--pass); }
  .verdict-pill[data-verdict="pending"]           { background: var(--attn-wash); color: var(--attn); }
  .round-date { color: var(--text-faint); font-size: var(--step--1); margin-left: auto; }
  .round-entry .outcome-definition { margin: 0 0 0.5rem; }
  .round-entry blockquote {
    margin: 0.75rem 0 0; padding: 0.6rem 0.9rem; border-left: 3px solid var(--line-strong);
    color: var(--text-dim); font-size: var(--step--1);
  }
</style>
</head>
<body>
${main}
</body>
</html>
`
}
