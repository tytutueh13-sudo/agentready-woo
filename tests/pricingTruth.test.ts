// Every plan the marketing names must be one a customer can actually reach a
// checkout for. This project has shipped a price with nothing behind it before
// — once as a live checkout for an unbuilt feature, and again as an Agency
// tier that was advertised on the landing page and in llms.txt, whose 25-store
// limit was enforced and whose webhook could grant it, but for which no
// checkout button was ever rendered.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { billingPage } from "../src/web.ts";

const LANDING = readFileSync(new URL("../marketing/landing/index.html", import.meta.url), "utf8");
const COMMERCE = readFileSync(new URL("../marketing/landing/commerce.html", import.meta.url), "utf8");
const LLMS = readFileSync(new URL("../marketing/landing/llms.txt", import.meta.url), "utf8");

/** Prices configured, as a live deployment would have them. */
const CHECKOUT = {
  clientToken: "live_synthetic_for_tests",
  prices: { report: "pri_report", pro: "pri_pro", agency: "pri_agency" },
};

const PAID_PLANS = [
  { name: "Commerce Readiness Packet", price: "$9", priceKey: "report" as const, button: "paddle-report-btn" },
  { name: "Pro", price: "$49", priceKey: "pro" as const, button: "paddle-pro-btn" },
  { name: "Agency", price: "$99", priceKey: "agency" as const, button: "paddle-agency-btn" },
];

test("the Release Gate root does not inherit commerce pricing", () => {
  for (const plan of PAID_PLANS) assert.equal(LANDING.includes(plan.price), false,
    `${plan.name} pricing belongs outside the Release Gate root`);
  assert.match(LANDING, /Release Gate settlement remains disabled/i);
  assert.match(COMMERCE, /separate connected-store surface/i);
  assert.match(LLMS, /separate from\s+the root five-tool Release Gate contract/i);
});

test("every advertised plan has a checkout a customer can actually open", () => {
  const html = billingPage("free", "buyer@example.com", CHECKOUT);
  for (const plan of PAID_PLANS) {
    assert.ok(html.includes(plan.button),
      `${plan.name} is advertised at ${plan.price} but the billing page renders no checkout for it`);
  }
  // And the button is wired to the configured price, not a placeholder.
  assert.ok(html.includes(CHECKOUT.prices.agency), "the Agency button must carry its price id");
});

test("an unconfigured plan says so rather than offering a button that cannot open", () => {
  const html = billingPage("free", "buyer@example.com", {
    clientToken: CHECKOUT.clientToken, prices: { report: "pri_report", pro: "pri_pro" },
  });
  assert.ok(!html.includes("paddle-agency-btn"), "no live button without a price id");
  assert.match(html, /Agency billing is being set up/,
    "and the reader is told why, rather than the option vanishing");
});

test("a Pro customer is still offered Agency, and an Agency customer is not", () => {
  const pro = billingPage("pro", "buyer@example.com", CHECKOUT);
  assert.ok(pro.includes("paddle-agency-btn"), "Agency is the upgrade path from Pro");

  const agency = billingPage("agency", "buyer@example.com", CHECKOUT);
  assert.ok(!agency.includes("paddle-agency-btn"), "nobody should be sold what they already have");
});
