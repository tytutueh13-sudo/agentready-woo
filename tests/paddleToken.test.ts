// Regression for the 2026-09-01 exposure: the Paddle server API key was set
// as PADDLE_CLIENT_TOKEN on the sibling Grant Fit worker and served publicly.
// This service embeds the same kind of value in page HTML.
import test from "node:test";
import assert from "node:assert/strict";
import { isPublishableClientToken } from "../src/core/paddleToken.ts";

// Shape of the value that was actually exposed, with a synthetic id — the real
// key is revoked, and there is no reason to keep a live-looking credential in
// the tree.
test("rejects the shape of the value that was exposed", () => {
  assert.equal(isPublishableClientToken("apikey_00000000000000000000000000"), false);
});

test("rejects a full Paddle server API key in either environment", () => {
  assert.equal(isPublishableClientToken("pdl_live_apikey_01abc"), false);
  assert.equal(isPublishableClientToken("pdl_sdbx_apikey_01abc"), false);
});

test("is not fooled by casing or surrounding whitespace", () => {
  assert.equal(isPublishableClientToken("  PDL_LIVE_APIKEY_01abc  "), false);
});

test("accepts a publishable client-side token", () => {
  assert.equal(isPublishableClientToken("live_1a2b3c4d5e6f7g8h9i0j1dd6e"), true);
  assert.equal(isPublishableClientToken("test_1a2b3c4d5e6f7g8h9i0j1dd6e"), true);
});

// Fail-closed on absence, so an unset secret renders a disabled button
// rather than a broken checkout.
test("treats empty, whitespace and undefined as not configured", () => {
  assert.equal(isPublishableClientToken(""), false);
  assert.equal(isPublishableClientToken("   "), false);
  assert.equal(isPublishableClientToken(undefined), false);
  assert.equal(isPublishableClientToken(null), false);
});
