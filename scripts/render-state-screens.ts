// Renders every state of the public product surface to a file, from fixtures.
//
// This is a build-time script, not a route. It imports the page functions the
// Worker imports and calls them with fixed arguments — there is no `?state=`
// parameter, no debug endpoint, and nothing here is reachable from a deployed
// Worker, which is the point: a preview seam that ships is a preview seam an
// agent can crawl and a reviewer can mistake for the product.
//
//   node --experimental-strip-types scripts/render-state-screens.ts
//
// Writes HTML to registration-handoff/marketplace-kit/state-screens/.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  scanFormPage, scanResultPage, dashboardPage, loginPage, billingPage,
  serviceErrorPage, storeCard,
} from "../src/web.ts";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..",
                 "registration-handoff", "marketplace-kit", "state-screens");

const SCORED_CHECKS = [
  { label: "Store is served over HTTPS", ok: true, detail: "https://northwindwool.example" },
  { label: "Store responds to requests", ok: true, detail: "HTTP 200" },
  { label: "WooCommerce Store API responds", ok: true, detail: "/wp-json/wc/store/v1/products" },
  { label: "Products have prices", ok: true, detail: "12/12" },
  { label: "Product structured data (JSON-LD) present", ok: false, detail: "no schema.org Product markup found" },
  { label: "Agent discovery file published", ok: false, detail: "missing — install the AgentReady Woo plugin" },
  { label: "AI crawlers not blocked in robots.txt", ok: true, detail: "GPTBot/ClaudeBot not disallowed" },
];

/** The nine states the completion round requires, plus the two the service had
 * no HTML for at all. Each entry is a whole page, exactly as the Worker would
 * return it. */
const SCREENS: Array<{ id: string; note: string; html: string }> = [
  { id: "01-initial", note: "First visit to the free scan.", html: scanFormPage() },

  { id: "02-loading", note:
      "Mid-submit. The button is disabled and the wait is announced; produced by "
      + "the same markup with the enhancement's end state applied, because the "
      + "real transition is a submit event.",
    html: scanFormPage().replace('<button class="btn" id="scan-go" type="submit">Run the scan</button>',
                                 '<button class="btn" id="scan-go" type="submit" disabled>Scanning…</button>')
                        .replace('id="scan-working" role="status" aria-live="polite" hidden',
                                 'id="scan-working" role="status" aria-live="polite"') },

  { id: "03-empty", note: "Signed in, nothing connected yet.",
    html: dashboardPage("merchant@northwindwool.example", "", `<a class="btn" href="/stores/new">Connect your first store</a>`) },

  { id: "04-validation-error", note: "The address was refused before any request was made.",
    html: scanFormPage("invalid_url", "northwindwool") },

  { id: "05-rate-limited", note: "Today's free scans from this connection are used up.",
    html: scanFormPage("rate_limited") },

  { id: "06-upstream-error", note: "Our service failed. Explicitly not a finding about the store.",
    html: serviceErrorPage("upstream") },

  { id: "07-not-found", note: "A miss. Previously four bytes of plain text.",
    html: serviceErrorPage("not_found") },

  { id: "08-auth-required", note: "The gated half, reached without a session.",
    html: loginPage("Sign in to reach your dashboard.", "merchant@northwindwool.example", true) },

  { id: "09-settlement-disabled", note:
      "Billing with settlement disabled: checkout is null, so no price is "
      + "actionable and none is offered.",
    html: billingPage("free", "merchant@northwindwool.example", null) },

  { id: "10-success", note: "A store that could be read, scored, with its gaps named.",
    html: scanResultPage({
      storeUrl: "https://northwindwool.example", state: "SCORED", score: 71, grade: "fair",
      unreadable: null, checks: SCORED_CHECKS,
      recommendations: [
        "Add Product structured data (JSON-LD) — most SEO plugins (Yoast, Rank Math) can do this automatically.",
        "Publish /.well-known/agenticweb.md (the free AgentReady Woo plugin does this in one install).",
      ],
    }) },

  { id: "11-abstained", note:
      "The state this product exists for: reached it, could not read it. No "
      + "score, no grade, no recommendations.",
    html: scanResultPage({
      storeUrl: "https://sablecoast.example", state: "UNREADABLE", score: null, grade: null,
      unreadable: { reason: "TARGET_UNREACHABLE", detail: "nothing answered at https://sablecoast.example within 8 seconds" },
      checks: SCORED_CHECKS.map(c => ({ ...c, ok: false })), recommendations: [],
    }) },
];

mkdirSync(OUT, { recursive: true });
const index: string[] = [];
for (const screen of SCREENS) {
  writeFileSync(join(OUT, `${screen.id}.html`), screen.html);
  index.push(`| \`${screen.id}\` | ${screen.note} |`);
}
writeFileSync(join(OUT, "README.md"), `# State screens

Rendered from fixtures by \`scripts/render-state-screens.ts\`. Nothing here is a
route: the script imports the page functions directly, so there is no debug
endpoint on the deployed Worker and no query parameter that can reach these.
Re-run the script after any change to \`src/web.ts\`.

| Screen | State |
| --- | --- |
${index.join("\n")}

Screenshots at 390 / 768 / 1280 / 1440 and at 200% zoom live beside the HTML.
`);
console.log(`${SCREENS.length} screens written to ${OUT}`);
void storeCard;
