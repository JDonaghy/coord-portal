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

  form.intake { display: grid; gap: 1.25rem; }
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
</style>
</head>
<body>
${main}
</body>
</html>
`
}
