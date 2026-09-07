// The states the public surface can be in, and the ones it must never be in.
//
// Every case here was a real gap: a store nobody could read was shown a score,
// a refused address came back as the blank form, a miss returned four bytes of
// plain text, and an unhandled throw reached the merchant as Cloudflare's own
// error page. The renders in registration-handoff/marketplace-kit/state-screens
// are generated from these same functions.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { scanFormPage, scanResultPage, serviceErrorPage } from "../src/web.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKS = [{ label: "Store responds to requests", ok: false, detail: "unreachable" }];

const ABSTAINED = {
  storeUrl: "https://sablecoast.example", state: "UNREADABLE" as const,
  score: null, grade: null,
  unreadable: { reason: "TARGET_UNREACHABLE", detail: "nothing answered at https://sablecoast.example within 8 seconds" },
  checks: CHECKS, recommendations: [],
};
const SCORED = {
  storeUrl: "https://northwindwool.example", state: "SCORED" as const,
  score: 71, grade: "fair", unreadable: null,
  checks: [{ label: "Store responds to requests", ok: true, detail: "HTTP 200" }],
  recommendations: ["Add Product structured data (JSON-LD)."],
};

// -- abstention -------------------------------------------------------------

test("the abstained page shows no score, no grade and no /100 anywhere", () => {
  const page = scanResultPage(ABSTAINED);
  assert.equal(/\/100/.test(page), false, "a number here would be a score of our own timeout");
  assert.equal(/class="score"/.test(page), false);
  assert.equal(/class="badge/.test(page), false, "there is no grade to badge");
  assert.match(page, /Could not tell/);
  assert.match(page, /TARGET_UNREACHABLE/);
});

test("the abstained page says the failure is about the request, not the store", () => {
  const page = scanResultPage(ABSTAINED);
  assert.match(page, /a fact about the\s*\n?request, not about your store/i);
  assert.equal(/What to do next/.test(page), false,
    "advice derived from checks that only failed because nothing answered is not advice");
});

test("a null score alone routes to the abstention page, even if state is missing", () => {
  // Old rows in the scans table predate `state`; they must not fall through to
  // the scoring branch and render `null/100`.
  const legacy = { ...ABSTAINED, state: undefined };
  assert.match(scanResultPage(legacy as never), /Could not tell/);
});

test("a scored store still gets its score and its grade", () => {
  const page = scanResultPage(SCORED);
  assert.match(page, /71<span>\/100<\/span>/);
  assert.match(page, /fair/);
  assert.match(page, /What to do next/);
});

// -- the form's states ------------------------------------------------------

test("a refused address comes back with a reason and the text still in the field", () => {
  const page = scanFormPage("invalid_url", "northwindwool");
  assert.match(page, /class="notice" role="alert"/);
  assert.match(page, /not a store address we can reach/i);
  assert.match(page, /value="northwindwool"/, "retyping it is the user's punishment for our error");
  assert.match(page, /aria-invalid="true"/);
});

test("the daily limit says what it is, and does not offer a button that cannot work", () => {
  const page = scanFormPage("rate_limited");
  assert.match(page, /resets at midnight UTC/);
  assert.match(page, /nothing was charged/i);
  assert.match(page, /<button[^>]*disabled>/);
});

test("the first visit carries no alert and an enabled button", () => {
  const page = scanFormPage();
  assert.equal(/role="alert"/.test(page), false);
  assert.equal(/<button[^>]*disabled>/.test(page), false);
});

test("the waiting state is an enhancement: the form works with the script removed", () => {
  const page = scanFormPage();
  const withoutScript = page.replace(/<script>[\s\S]*?<\/script>/g, "");
  assert.match(withoutScript, /<form method="post" action="\/scan"/,
    "the submit path must not depend on JavaScript");
  assert.match(page, /aria-live="polite"/, "a wait that is only drawn is not announced");
});

// -- whose fault it is ------------------------------------------------------

test("the error pages name the responsible party", () => {
  const upstream = serviceErrorPage("upstream");
  assert.match(upstream, /not a finding about your store/i);
  assert.match(upstream, /nothing was scanned and nothing was charged/i);
  const notFound = serviceErrorPage("not_found");
  assert.match(notFound, /nothing at this address/i);
  for (const page of [upstream, notFound]) {
    assert.match(page, /href="\/scan"/, "an error page with no way out is a dead end");
  }
});

// -- the render seam must not be shippable ---------------------------------

test("the fixture seam is not reachable from the Worker", () => {
  // The state screens exist so a reviewer can see every state. If that seam
  // were a route, it would be a public endpoint that renders fixtures, and a
  // crawler would index a fabricated scan result as a real one. The seam is a
  // build-time script: `src/` must never import it, name its output, or route
  // to a preview path.
  //
  // (This deliberately does not forbid `searchParams.get("state")` — that is
  // the OAuth CSRF state in src/app.ts, and a pattern broad enough to catch a
  // fixture seam by that name catches the real one instead.)
  for (const file of readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(ROOT, "src", file), "utf8");
    for (const forbidden of [/render-state-screens/, /state-screens/, /["'`]\/__?debug/,
                             /["'`]\/preview\//, /["'`]\/_states?["'`]/]) {
      assert.equal(forbidden.test(source), false, `src/${file} reaches the fixture seam: ${forbidden}`);
    }
  }
});

test("the render script imports the product's own pages, not copies of them", () => {
  // A seam that renders its own markup proves nothing about the product.
  const script = readFileSync(join(ROOT, "scripts/render-state-screens.ts"), "utf8");
  assert.match(script, /from "\.\.\/src\/web\.ts"/);
  assert.equal(/<html|<!doctype/i.test(script), false,
    "the script must not contain markup of its own");
});

function onlyInMonorepo(dir: string): boolean {
  try { statSync(join(ROOT, dir)); return false; } catch { return true; }
}

test("every required state has a rendered screen on disk", (t) => {
  if (onlyInMonorepo("registration-handoff")) return t.skip("public mirror: rendered screens are withheld");
  const dir = join(ROOT, "registration-handoff/marketplace-kit/state-screens");
  const names = readdirSync(dir).filter(f => f.endsWith(".html")).join(" ");
  for (const state of ["initial", "loading", "empty", "validation-error", "rate-limited",
                       "upstream-error", "not-found", "auth-required", "settlement-disabled",
                       "success", "abstained"]) {
    assert.ok(names.includes(state), `no rendered screen for the ${state} state`);
  }
});

test("the settlement-disabled screen offers no purchase", (t) => {
  if (onlyInMonorepo("registration-handoff")) return t.skip("public mirror: rendered screens are withheld");
  const dir = join(ROOT, "registration-handoff/marketplace-kit/state-screens");
  const page = readFileSync(join(dir, "09-settlement-disabled.html"), "utf8");
  assert.equal(/checkout\.paddle|data-price-id|Buy now|Pay \$/i.test(page), false,
    "a purchase control on a surface that cannot settle is the phantom-checkout failure");
});

// -- contrast, measured rather than asserted --------------------------------

test("the primary button is not the 3.68:1 accent", () => {
  // #E4572E behind white 15px text measured 3.68:1 on every page that has a
  // button. #C43F1B is 5.15:1.
  const css = readFileSync(join(ROOT, "src/web.ts"), "utf8");
  assert.match(css, /\.btn\{display:inline-block;background:var\(--acc-dark\)/);
  assert.equal(/\.btn\{display:inline-block;background:var\(--acc\)/.test(css), false);
});

test("the grade badge on the dark score card is not --ink2", () => {
  const css = readFileSync(join(ROOT, "src/web.ts"), "utf8");
  assert.match(css, /\.score-card \.badge\{color:#F2EFF6/,
    "--ink2 on the dark card measured 2.41:1");
  assert.match(scanResultPage(SCORED), /class="card score-card"/);
});

test("a long store URL cannot push the result page sideways", () => {
  // The result page's h1 is the store's own address. Without a break rule a
  // real merchant hostname is one unbreakable token, and the success screen
  // scrolled horizontally by 22px at 390px — measured, then fixed.
  const css = readFileSync(join(ROOT, "src/web.ts"), "utf8");
  const h1 = /\nh1\{[^}]*\}/.exec(css);
  assert.ok(h1, "the h1 rule moved; re-point this test");
  assert.match(h1[0], /overflow-wrap:anywhere/,
    "an unbreakable hostname in the h1 overflows the page on a phone");
});
