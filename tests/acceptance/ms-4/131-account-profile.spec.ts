import { expect, test, type Browser, type Page } from "@playwright/test"

/**
 * ms-4 sealed acceptance slice — issue #131
 * "Client profile page: self-service phone/cc emails/address behind Access auth"
 *
 * Written from `tests/acceptance/ms-4/contract.md` (§ "Client self-service
 * profile (#131) — mock 06") and from `mocks/06-account-profile.html`, without
 * sight of any implementation.
 *
 * ── WHAT #131 ACTUALLY BUYS ─────────────────────────────────────────────────
 *
 * The issue's own words: "a page, behind the existing Cloudflare Access auth
 * (no new auth code), where a signed-in client can view and edit their own
 * `clients` row: phone, cc emails, address. Email stays read-only (it's the
 * Access identity, not an editable field). Pure CRUD on the optional columns
 * the sibling schema issue adds." The originating ask was explicitly that the
 * client populate this themselves rather than the operator collecting it by
 * hand.
 *
 * The contract turns that into a concrete surface: `GET /account` and
 * `POST /account` behind the same customer Access application `/submissions*`
 * already sits behind, one additive `nav-account` entry on the shared customer
 * `topbar()`, and a form of four fields of which exactly one (`account-email`)
 * is read-only. Saving follows this repo's PRG convention: 3xx back to
 * `GET /account`, with the new values already reflected in the same fields.
 *
 * So this slice asserts five things, and they are the five the issue names:
 *
 *  1. **The page exists, behind the caller's own Access identity**, with every
 *     hook the contract's § "data-testid hooks" pins for `/account`, and is
 *     reachable from the customer nav on every authenticated screen.
 *  2. **A customer with nothing on file can still use it** — every optional
 *     field blank, only the email pre-filled (contract § "A gap #131 leaves
 *     open, resolved here"; see the TODO on that test, this is the contract's
 *     own invention rather than #131's text).
 *  3. **Saving works, and sticks** — "view and edit", the whole point of the
 *     issue: phone / ccEmails / address round-trip through `POST /account`,
 *     survive a fresh visit, and can be edited again afterwards.
 *  4. **Email is not editable here** — read-only in the form, and unmoved by a
 *     hand-rolled POST that tries to change it. #131 is explicit; it is the one
 *     field of the four this page must refuse.
 *  5. **"Their own" means their own** — one signed-in client never sees or
 *     overwrites another's row. #131's whole framing is self-service on the
 *     caller's own record, and this repo's ownership scoping (ms-1's `/outbox`,
 *     `/submissions`) is per-Access-identity.
 *
 * ── WHAT THIS SLICE DELIBERATELY DOES NOT ASSERT ────────────────────────────
 *
 *  - **#128's schema.** `128-clients-schema.spec.ts` owns the `clients` table's
 *    columns, indexes and nullability. Nothing here reads the schema; this file
 *    only ever drives the rendered page.
 *  - **#129's lead-promotion path into `clients`.** The contract resolves the
 *    "no row yet" gap by having `POST /account` create the row on first save,
 *    so this slice never needs a promoted lead — and asserting on
 *    `client-attachment` or `client-match-card` would make it red for another
 *    issue's missing hook.
 *  - **A "saved" confirmation banner.** The contract pins the redirect and the
 *    reflected values, and explicitly declines to pin a banner ("a worker may
 *    add one additively").
 *  - **`GET /api/bridge/pull`.** Nothing in #131 or the contract pins a bridge
 *    event for a profile edit, and contract note 1 is emphatic that this
 *    milestone's event-kind question was unreadable at Gate-A time.
 *  - **Validation of phone / cc-email syntax.** #131 calls these "optional
 *    columns" and "pure CRUD"; neither it nor the contract pins any format
 *    rule, so this file submits well-formed synthetic values and asserts they
 *    come back, never that a malformed one is rejected.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every email, name, phone number and address below is invented and
 * sits on RFC 6761's reserved `.test` TLD. The phone numbers use the +1 555-01xx
 * fictional range; the addresses name no real place.
 *
 * ── AMENDMENT 1 (2026-09-02) — account-nav surface correction ───────────────
 *
 * Requested by the operator after this slice was originally sealed, and applied
 * to `contract.md` by an independent mock-author agent without sight of this
 * file's implementation. It supersedes only where `nav-account` and
 * `identity-email` render and when they are visible: both move from *always
 * visible, flat in the main nav row* to *present in the DOM inside a new
 * `account-menu` disclosure's panel, visible only once that menu is open*.
 * Their text, attributes and `href`s are unchanged. The amendment's own text
 * (contract.md § "Amendment 1", warning box) names exactly two assertions in
 * this file it breaks — `"the profile is reachable from every authenticated
 * customer screen"` and `"adding the profile entry disturbs nothing on the
 * existing customer topbar"` — both re-authored below to open the menu before
 * asserting visibility. Every other test in this file only ever asserts
 * `identity-email`/`nav-account` with `toContainText`/`toHaveAttribute`, which
 * do not require visibility and so needed no change; the amendment's own grep
 * says as much and this rewrite double-checked it directly.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/**
 * A cold `wrangler dev` plus a couple of full page round-trips per test is more
 * than the 30s default comfortably covers; the whole file is cheap otherwise
 * (no leads, no bridge, no mail drain).
 */
test.describe.configure({ timeout: 60_000 })

/**
 * Actions get a short leash, for the same reason `130-reassign-project.spec.ts`
 * gives them one: `fill()`, `click()` and `evaluate()` have no default timeout,
 * so in a suite written before the implementation exists — where every hook
 * touched here is *expected* to be missing — an unguarded action turns a red
 * test into a silent minute-long hang ending in "Test timeout exceeded", which
 * names nothing. Capped, a missing hook fails in seconds and says which one.
 * Every action below is additionally preceded by an explicit visibility
 * assertion; this is the backstop for the ones a future edit forgets.
 */
test.use({ actionTimeout: 15_000 })

// ── identities ──────────────────────────────────────────────────────────────

/**
 * Local `wrangler dev` has no Access in front of it, so the verified identity
 * is injected as the header Access injects in production — the same instrument
 * ms-1's `12-access-auth.spec.ts` and ms-3's slices use.
 */
function asCustomer(browser: Browser, baseURL: string | undefined, email: string) {
  return browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: email } })
}

/** A caller with no Access identity at all. */
function asNobody(browser: Browser, baseURL: string | undefined) {
  return browser.newContext({ baseURL })
}

// ── the profile form ────────────────────────────────────────────────────────

/** The three writable columns #131 names, in the shape the form carries them. */
interface Profile {
  phone: string
  ccEmails: string
  address: string
}

/**
 * Open `GET /account` and assert the form is actually on the screen before
 * anything tries to type into it.
 */
async function openAccount(page: Page): Promise<void> {
  await page.goto("/account")
  await expect(
    page.getByTestId("account-form"),
    "#131's whole surface is `GET /account` rendering `account-form` for the signed-in client",
  ).toBeVisible()
}

/** Fill the three editable fields and press save, landing back on the page. */
async function saveProfile(page: Page, profile: Profile): Promise<void> {
  for (const [hook, value] of [
    ["account-phone-field", profile.phone],
    ["account-cc-emails-field", profile.ccEmails],
    ["account-address-field", profile.address],
  ] as const) {
    await expect(
      page.getByTestId(hook),
      `${hook} has to be on the screen before a client can type into it`,
    ).toBeVisible()
    await page.getByTestId(hook).fill(value)
  }

  await expect(
    page.getByTestId("account-save-button"),
    "`account-save-button` submits `account-form` — without it the page is view-only, " +
      "which is exactly the half of #131 the operator was doing by hand",
  ).toBeVisible()
  await page.getByTestId("account-save-button").click()

  // The PRG landing is the sync point: the contract pins `POST /account`
  // redirecting to `GET /account`, so the form is on the screen again at the
  // page's own URL once the round-trip is done.
  await expect(
    page.getByTestId("account-form"),
    "saving lands back on a fresh GET /account (this repo's PRG convention, contract § " +
      "'Client self-service profile')",
  ).toBeVisible()
  expect(
    new URL(page.url()).pathname,
    "#131 is a self-service page, not a wizard — saving returns the client to it",
  ).toBe("/account")
}

/** What the three editable fields currently hold. */
async function readProfile(page: Page): Promise<Profile> {
  return {
    phone: await page.getByTestId("account-phone-field").inputValue(),
    ccEmails: await page.getByTestId("account-cc-emails-field").inputValue(),
    address: await page.getByTestId("account-address-field").inputValue(),
  }
}

/** Every `data-testid` the contract pins for `/account`, form half only. */
const ACCOUNT_HOOKS = [
  "account-form",
  "account-email",
  "account-phone-field",
  "account-cc-emails-field",
  "account-address-field",
  "account-save-button",
]

/**
 * The customer topbar hooks ms-1 pins that stay flat, always-visible, and
 * untouched by both #131 and Amendment 1. `identity-email` is deliberately
 * absent from this list and handled on its own in the ratchet test below:
 * Amendment 1 moves it into the account-menu panel, present in the DOM but
 * visible only once that menu is open.
 */
const EXISTING_TOPBAR = ["brand-home", "nav-dashboard", "nav-new", "nav-outbox"]

test.describe("ms-4 issue 131 client self-service profile", () => {
  /**
   * The page itself, and the six hooks the contract's § "data-testid hooks"
   * pins under `/account`, against mock 06.
   *
   * The field *names* are asserted because the contract pins them by name —
   * `name="phone"`, `name="ccEmails"`, `name="address"` — and they are the
   * wire contract between this form and `POST /account`. The input *types* are
   * not: mock 06 renders `type="tel"` for the phone, the contract's prose does
   * not, and #131 does not care.
   */
  test("the profile page renders behind the caller's own Access identity", async ({
    browser,
    baseURL,
  }) => {
    const email = "wren.renders.131@example.test"
    const context = await asCustomer(browser, baseURL, email)
    const page = await context.newPage()
    await openAccount(page)

    for (const hook of ACCOUNT_HOOKS) {
      await expect(
        page.getByTestId(hook),
        `contract § 'data-testid hooks': ${hook} is pinned for /account`,
      ).toBeVisible()
    }

    const form = page.getByTestId("account-form")
    await expect(form, "the form posts to #131's own route").toHaveAttribute("action", "/account")
    await expect(form, "…as a POST").toHaveAttribute("method", /post/i)

    await expect(
      page.getByTestId("account-phone-field"),
      "contract: `account-phone-field` (`name=\"phone\"`)",
    ).toHaveAttribute("name", "phone")
    await expect(
      page.getByTestId("account-cc-emails-field"),
      "contract: `account-cc-emails-field` (`name=\"ccEmails\"`, comma-separated per #128's own " +
        "column comment)",
    ).toHaveAttribute("name", "ccEmails")
    await expect(
      page.getByTestId("account-address-field"),
      "contract: `account-address-field` (`name=\"address\"`)",
    ).toHaveAttribute("name", "address")

    // "optional, multi-line" (contract) — mock 06 renders a <textarea>. An
    // address that cannot hold a second line is not an address field.
    expect(
      await page.getByTestId("account-address-field").evaluate((el) => el.tagName),
      "the address is multi-line (contract § 'Client self-service profile'; mock 06 renders a " +
        "textarea) — a single-line input cannot hold one",
    ).toBe("TEXTAREA")

    // The signed-in identity is the page's whole premise: no login, no
    // password, just the identity Access injected (CLAUDE.md; #131's "behind
    // the existing Cloudflare Access auth ... no new auth code").
    await expect(
      page.getByTestId("identity-email"),
      "every authenticated screen names the signed-in customer (ms-1's contract)",
    ).toContainText(email)
    await expect(
      page.locator('input[type="password"]'),
      "#131 adds no auth code of its own — there is nothing to log into here",
    ).toHaveCount(0)

    await context.close()
  })

  /**
   * Contract § "A gap #131 leaves open, resolved here": a customer who has
   * never been through lead promotion has no `clients` row at all, and
   * "`GET /account` renders the form with every optional field blank (only
   * `account-email` pre-filled) when no `clients` row exists yet".
   *
   * This is the population #131 exists for — the originating ask was that the
   * client populate this themselves — so a 404 here would make the feature
   * unusable for exactly the people asking for it.
   *
   * TODO(test-author): the contract is explicit that this resolution is its own
   * invention and that #131's text does not say it ("an implementer who reads
   * the issue and reasonably reaches a different conclusion ... knows this
   * contract chose the other reading on purpose"). This test holds the contract
   * to its own choice; if that choice is ever revisited, this is the test that
   * has to change with it, not a bug in the implementation.
   */
  test("a customer with nothing on file yet gets an empty, usable form", async ({
    browser,
    baseURL,
  }) => {
    // Never promoted, never seen: this identity exists nowhere in the database.
    const email = "isolde.brandnew.131@example.test"
    const context = await asCustomer(browser, baseURL, email)
    const page = await context.newPage()
    await openAccount(page)

    await expect(
      page.getByTestId("account-email"),
      "only `account-email` is pre-filled for a client with no row yet — it is the Access " +
        "identity, which the portal always knows",
    ).toHaveValue(email)

    const blank = await readProfile(page)
    expect(
      blank,
      "every optional field starts blank for a client with no `clients` row (contract § 'A gap " +
        "#131 leaves open, resolved here') — and the form is offered anyway, not 404'd",
    ).toEqual({ phone: "", ccEmails: "", address: "" })

    await expect(
      page.getByTestId("account-save-button"),
      "…and it is usable: `POST /account` creates the row on first save",
    ).toBeEnabled()

    await context.close()
  })

  /**
   * Contract § "Client self-service profile" + Amendment 1 § "Account menu":
   * `nav-account` (text 'My profile', `href="/account"`) lives inside the
   * `account-menu` disclosure's panel on the shared customer `topbar()`, so it
   * reaches every authenticated customer screen — which is what makes the page
   * discoverable without the operator sending a link. Amendment 1 moved the
   * hook off the flat nav row into that panel: present in the DOM everywhere,
   * visible only once the menu is open (§ "Visibility pinning"). This is one of
   * the two tests the amendment's own warning box names as broken by that
   * move — re-authored here to open the menu before asserting visibility,
   * rather than asserting on the pre-amendment flat rendering.
   */
  test("the profile is reachable from every authenticated customer screen", async ({
    browser,
    baseURL,
  }) => {
    const email = "nadia.nav.131@example.test"
    const context = await asCustomer(browser, baseURL, email)
    const page = await context.newPage()

    for (const screen of ["/intake", "/submissions", "/outbox", "/account"]) {
      await page.goto(screen)

      const menu = page.getByTestId("account-menu")
      await expect(
        menu,
        `contract § 'Account menu': the trigger sits on the shared customer topbar(), so it ` +
          `renders on ${screen} too`,
      ).toBeVisible()
      await expect(
        menu,
        "contract: the trigger's text is the first two characters of the signed-in email's " +
          "local-part, uppercased",
      ).toHaveText("NA")
      await expect(
        menu,
        "…and the accessible name spells out the full signed-in address",
      ).toHaveAttribute("aria-label", `Account menu (${email})`)
      await expect(
        menu,
        `closed by default on a fresh load of ${screen} — no mock in this amendment shows a ` +
          "freshly-rendered screen with the menu already open",
      ).toHaveAttribute("aria-expanded", "false")

      const entry = page.getByTestId("nav-account")
      await expect(
        entry,
        `Amendment 1: nav-account is present in the DOM on ${screen}, inside the account-menu panel`,
      ).toBeAttached()
      await expect(
        entry,
        `Amendment 1 § 'Visibility pinning': nav-account is not visible on ${screen} while the ` +
          "menu is closed",
      ).toBeHidden()

      await menu.click()
      await expect(
        entry,
        `Amendment 1: opening the menu on ${screen} makes nav-account visible`,
      ).toBeVisible()
      await expect(entry, "contract: text 'My profile'").toHaveText("My profile")
      await expect(entry, "…linking to #131's route").toHaveAttribute("href", "/account")
    }

    // Mock 06, and the same convention every other topbar mock in this repo
    // renders (ms-1's `nav-dashboard`/`nav-new`, ms-3's `nav-deliveries`): the
    // entry for the screen you are on marks itself as current. Amendment 1
    // moves the element's container and visibility, not this attribute.
    await page.goto("/account")
    await page.getByTestId("account-menu").click()
    await expect(
      page.getByTestId("nav-account"),
      "mock 06 renders `aria-current=\"page\"` on the entry for the screen being shown, the same " +
        "way every other topbar mock in this repo does",
    ).toHaveAttribute("aria-current", "page")

    await context.close()
  })

  /**
   * The issue in one test: a signed-in client fills in their own phone, cc
   * emails and address, and the portal keeps them. "Rather than the operator
   * collecting it by hand."
   *
   * The second visit is the part that matters — a form that echoes what was
   * typed but stores nothing would pass a same-page check.
   *
   * TODO(test-author): neither #131 nor the contract pins any normalisation of
   * `ccEmails` (the column comment says only "comma-separated"), so this
   * asserts that both addresses and a separating comma survive the round-trip
   * rather than a byte-for-byte echo — a worker who trims whitespace around the
   * commas is not failed for it.
   */
  test("a client can put their own phone, cc emails and address on file", async ({
    browser,
    baseURL,
  }) => {
    const email = "theo.saves.131@example.test"
    const profile: Profile = {
      phone: "+1 555-0173",
      ccEmails: "billing@example.test, ops@example.test",
      address: "Unit 4, The Old Bottling Works\nRiverside Lane\nEastmarch EM4 2QP",
    }

    const context = await asCustomer(browser, baseURL, email)
    const page = await context.newPage()
    await openAccount(page)
    await saveProfile(page, profile)

    const reflected = await readProfile(page)
    expect(
      reflected.phone,
      "the redirect lands on a GET of the page with the new values already in it (contract § " +
        "'Client self-service profile')",
    ).toBe(profile.phone)
    expect(reflected.address, "…including the multi-line address, newlines intact").toBe(
      profile.address,
    )
    for (const cc of ["billing@example.test", "ops@example.test"]) {
      expect(
        reflected.ccEmails,
        `both cc addresses survive the round-trip. Got: ${JSON.stringify(reflected.ccEmails)}`,
      ).toContain(cc)
    }
    expect(
      reflected.ccEmails,
      "`clients.cc_emails` is comma-separated (#128's own column comment), so a list of two keeps " +
        `its separator. Got: ${JSON.stringify(reflected.ccEmails)}`,
    ).toContain(",")

    // A different visit entirely, on a fresh page: this is the difference
    // between "the form echoed me" and "the portal stored it".
    const later = await context.newPage()
    await openAccount(later)
    const persisted = await readProfile(later)
    expect(
      persisted.phone,
      "#131 is CRUD on a stored row, not a form that echoes what was just typed — a later visit " +
        "still shows what the client saved",
    ).toBe(profile.phone)
    expect(persisted.address, "…and the address too").toBe(profile.address)
    for (const cc of ["billing@example.test", "ops@example.test"]) {
      expect(persisted.ccEmails, "…and both cc addresses").toContain(cc)
    }

    await context.close()
  })

  /**
   * "View and **edit**" (#131). The second save has to replace the first, not
   * append to it or be ignored because a row already exists.
   *
   * TODO(test-author): neither #131 nor the contract says what an *emptied*
   * field means — "clear this value" or "leave it as it was". Nothing here
   * submits a blank over a non-blank value, because either reading is defensible
   * and this slice will not invent one.
   */
  test("editing a profile that already exists replaces what was there", async ({
    browser,
    baseURL,
  }) => {
    const context = await asCustomer(browser, baseURL, "marlow.edits.131@example.test")
    const page = await context.newPage()

    await openAccount(page)
    await saveProfile(page, {
      phone: "+1 555-0118",
      ccEmails: "first@example.test",
      address: "12 Kiln Row\nEastmarch EM1 7DF",
    })

    const updated: Profile = {
      phone: "+1 555-0199",
      ccEmails: "second@example.test, third@example.test",
      address: "Studio 9, The Maltings\nWestmarch WM3 5RT",
    }
    await saveProfile(page, updated)

    const fresh = await context.newPage()
    await openAccount(fresh)
    const stored = await readProfile(fresh)
    expect(stored.phone, "the newer phone number replaces the older one").toBe(updated.phone)
    expect(stored.phone, "…and the older one is gone, not kept alongside it").not.toContain(
      "555-0118",
    )
    expect(stored.address, "the newer address replaces the older one").toBe(updated.address)
    expect(
      stored.ccEmails,
      "the newer cc list replaces the older one — an edit is not an append",
    ).not.toContain("first@example.test")
    expect(stored.ccEmails, "…and holds what was actually saved").toContain("second@example.test")

    await context.close()
  })

  /**
   * The PRG half of the contract, at the transport level: "`POST /account`
   * redirecting to `GET /account` with the new values already reflected in the
   * same fields is the pinned behavior".
   *
   * TODO(test-author): the contract cites this repo's convention ("every other
   * form in this portal 303s back to a GET of itself") but pins no specific
   * status code for `POST /account`, so this asserts *a* redirect back to the
   * page and not which 3xx carried it.
   */
  test("saving redirects back to the profile page rather than rendering a dead end", async ({
    request,
  }) => {
    const email = "priya.prg.131@example.test"
    const res = await request.post("/account", {
      headers: { [ACCESS_HEADER]: email },
      form: {
        phone: "+1 555-0164",
        ccEmails: "studio@example.test",
        address: "3 Weavers Yard\nEastmarch EM2 9BB",
      },
      maxRedirects: 0,
      failOnStatusCode: false,
    })

    const status = res.status()
    expect(
      status,
      `POST /account is a redirect back to the page, not a rendered response (got ${status})`,
    ).toBeGreaterThanOrEqual(300)
    expect(status, `POST /account should not be an error (got ${status})`).toBeLessThan(400)

    const location = res.headers()["location"] ?? ""
    expect(
      new URL(location, "http://127.0.0.1").pathname,
      `the client lands back on their own profile. Location: ${location || "(none)"}`,
    ).toBe("/account")

    const after = await request.get("/account", { headers: { [ACCESS_HEADER]: email } })
    expect(after.status(), "…and that GET renders").toBe(200)
    expect(
      await after.text(),
      "the values the POST carried are already reflected on the page it redirects to",
    ).toContain("+1 555-0164")
  })

  /**
   * #131, verbatim: "Email stays read-only (it's the Access identity, not an
   * editable field)."
   *
   * Two halves, because the form-level half alone is cosmetic: the input is
   * marked `readonly`, *and* a hand-rolled POST carrying an `email` field —
   * which is all a `readonly` attribute stops a browser from sending — does not
   * move the identity the page renders. If it did, a client could point their
   * own profile at somebody else's address.
   */
  test("the sign-in address cannot be edited from this form", async ({
    browser,
    baseURL,
    request,
  }) => {
    const email = "quill.readonly.131@example.test"
    const context = await asCustomer(browser, baseURL, email)
    const page = await context.newPage()
    await openAccount(page)

    const emailField = page.getByTestId("account-email")
    await expect(emailField, "the caller's own Access email is what it shows").toHaveValue(email)
    expect(
      await emailField.evaluate(
        (el) => (el as HTMLInputElement).readOnly || (el as HTMLInputElement).disabled,
      ),
      "#131: 'Email stays read-only ... it's the Access identity, not an editable field'",
    ).toBe(true)
    expect(
      await emailField.evaluate((el) => el.getAttribute("name")),
      "a read-only identity has no business being submitted back — but if it is named, the POST " +
        "must still ignore it, which the second half of this test checks",
    ).not.toBe("")

    // The hand-rolled POST: exactly what a client with dev tools can send.
    const intruder = "someone.else.131@example.test"
    await request.post("/account", {
      headers: { [ACCESS_HEADER]: email },
      form: {
        email: intruder,
        phone: "+1 555-0125",
        ccEmails: "",
        address: "",
      },
      maxRedirects: 0,
      failOnStatusCode: false,
    })

    await openAccount(page)
    await expect(
      page.getByTestId("account-email"),
      "the profile still belongs to the Access identity that signed in — a posted `email` field " +
        "is not a way to change it",
    ).toHaveValue(email)
    await expect(
      page.getByTestId("identity-email"),
      "…and the header still names the same person",
    ).toContainText(email)

    const body = await (
      await request.get("/account", { headers: { [ACCESS_HEADER]: intruder } })
    ).text()
    expect(
      body,
      "the address that was posted did not quietly acquire the other client's phone number either",
    ).not.toContain("555-0125")

    await context.close()
  })

  /**
   * "Their own `clients` row" (#131). Ownership in this portal is scoped to the
   * Access identity — ms-1's `/submissions` and `/outbox` both are — and a
   * self-service profile page is the most direct place to get that wrong: one
   * missing `WHERE email = ?` and every client edits the same record.
   */
  test("one client's profile is never another's", async ({ browser, baseURL }) => {
    const one = "ines.owner.131@example.test"
    const other = "otto.owner.131@example.test"

    const oneContext = await asCustomer(browser, baseURL, one)
    const onePage = await oneContext.newPage()
    await openAccount(onePage)
    await saveProfile(onePage, {
      phone: "+1 555-0131",
      ccEmails: "ines.billing@example.test",
      address: "5 Tannery Steps\nEastmarch EM5 1AA",
    })

    const otherContext = await asCustomer(browser, baseURL, other)
    const otherPage = await otherContext.newPage()
    await openAccount(otherPage)

    await expect(
      otherPage.getByTestId("account-email"),
      "the page shows the caller their own row, keyed on the identity Access verified",
    ).toHaveValue(other)
    const otherProfile = await readProfile(otherPage)
    expect(
      otherProfile,
      "a second client's profile is their own, blank, row — not the first client's",
    ).toEqual({ phone: "", ccEmails: "", address: "" })
    expect(
      await otherPage.locator("body").innerText(),
      "and nothing of the first client's details leaks onto this screen",
    ).not.toContain("555-0131")

    // Now the second client saves, and the first is untouched.
    await saveProfile(otherPage, {
      phone: "+1 555-0146",
      ccEmails: "otto.billing@example.test",
      address: "8 Foundry Walk\nWestmarch WM1 3ZP",
    })

    const oneAgain = await oneContext.newPage()
    await openAccount(oneAgain)
    const oneProfile = await readProfile(oneAgain)
    expect(
      oneProfile.phone,
      "the first client's own row survived the second client saving theirs",
    ).toBe("+1 555-0131")
    expect(oneProfile.ccEmails, "…all of it").toContain("ines.billing@example.test")
    expect(
      oneProfile.address,
      "…and one client's save never lands on another's record",
    ).not.toContain("Foundry Walk")

    await oneContext.close()
    await otherContext.close()
  })

  // ── controls and ratchets: green now, and must stay green ─────────────────

  /**
   * CONTROL — expected GREEN both before and after #131, and therefore absent
   * from the manifest's `expected_red` block (observed, not intended).
   *
   * Green today only because `/account` does not exist; it earns its place by
   * staying green *after* the route lands, which is the moment the gate could
   * actually be got wrong. #131 says "behind the existing Cloudflare Access
   * auth" — a new route that forgot to resolve an identity would serve a
   * client's contact details to an unidentified caller, which is precisely the
   * material CLAUDE.md's rule 1 exists to protect.
   *
   * The seeding POST is deliberately unasserted: it cannot succeed before #131
   * lands, and this control must not go red for the absence of the very feature
   * it is guarding.
   *
   * TODO(test-author): neither ms-1's contract nor ms-4's pins what an
   * identity-less request receives (ms-1's own slice notes a 302 to Access, a
   * 401 and an empty shell are all consistent), so no status code is asserted
   * here — only that no customer material comes back.
   */
  test("a caller with no Access identity is served no profile material", async ({
    browser,
    baseURL,
    request,
  }) => {
    const email = "sable.private.131@example.test"
    const secretPhone = "+1 555-0187"
    const secretAddress = "22 Chandlers Reach"

    // Unasserted on purpose — see the note above.
    await request
      .post("/account", {
        headers: { [ACCESS_HEADER]: email },
        form: { phone: secretPhone, ccEmails: "", address: secretAddress },
        maxRedirects: 0,
        failOnStatusCode: false,
      })
      .catch(() => {})

    const nobody = await asNobody(browser, baseURL)
    const page = await nobody.newPage()
    await page.goto("/account")
    const rendered = await page.locator("body").innerText()
    for (const secret of [secretPhone, secretAddress, email]) {
      expect(
        rendered,
        `an unidentified caller is never served a client's own contact details (${secret})`,
      ).not.toContain(secret)
    }
    await nobody.close()

    // Same at the transport level, in case the screen renders client-side.
    const raw = await request.get("/account", { failOnStatusCode: false })
    const body = await raw.text()
    for (const secret of [secretPhone, secretAddress, email]) {
      expect(body, `…and not in the raw response either (${secret})`).not.toContain(secret)
    }
  })

  /**
   * RATCHET — expected GREEN both before and after #131, and therefore absent
   * from the manifest's `expected_red` block.
   *
   * #131 *adds* an entry to a `topbar()` every authenticated customer screen
   * already shares. The contract is explicit: "additive the same way issue #14
   * added `nav-outbox` — every other `topbar()` hook (`brand-home`,
   * `nav-dashboard`, `nav-new`, `nav-outbox`, `identity-email`) is unchanged."
   * The most plausible way to get that wrong is not "the entry is missing" —
   * the nav test above catches that — it is "the entry arrived and displaced
   * something". This is what notices.
   *
   * Amendment 1 § "Account menu" narrows what "unchanged" means for
   * `identity-email` specifically: it keeps its text and meaning, but moves
   * from *always visible in the main row* to *present in the DOM inside the
   * account-menu panel, visible only once that menu is open*. This is the
   * second of the two tests the amendment's own warning box names as broken
   * by that move — re-authored below to check for the hook's presence and
   * then open the menu before asserting visibility, rather than asserting
   * `.toBeVisible()` against the pre-amendment flat rendering. `brand-home`,
   * `nav-dashboard`, `nav-new` and `nav-outbox` are untouched by the amendment
   * and still checked exactly as before.
   */
  test("adding the profile entry disturbs nothing on the existing customer topbar", async ({
    browser,
    baseURL,
  }) => {
    const email = "rafi.ratchet.131@example.test"
    const context = await asCustomer(browser, baseURL, email)
    const page = await context.newPage()

    for (const screen of ["/intake", "/submissions", "/outbox"]) {
      await page.goto(screen)
      for (const hook of EXISTING_TOPBAR) {
        await expect(
          page.getByTestId(hook),
          `ms-1's ${hook} keeps exactly its meaning and rendering on ${screen} — #131 only adds`,
        ).toBeVisible()
      }

      const identity = page.getByTestId("identity-email")
      await expect(
        identity,
        `…and ${screen} still carries the signed-in customer's identity in the DOM`,
      ).toBeAttached()
      await expect(
        identity,
        `Amendment 1: identity-email is not visible on ${screen} while the account menu is closed`,
      ).toBeHidden()

      await page.getByTestId("account-menu").click()
      await expect(
        identity,
        `…and opening the menu on ${screen} reveals it again`,
      ).toBeVisible()
      await expect(identity, `…and it still names the signed-in customer`).toContainText(email)
    }

    await context.close()
  })
})
