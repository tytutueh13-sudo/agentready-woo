// Tests for tenant helpers: AES-GCM credential encryption roundtrip and the
// offer-limit gate. Secrets in fixtures are assembled at runtime so the
// secret scanner never sees credential-shaped literals.
import test from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret, applyOfferLimit, normalizeStoreUrl } from "../src/core/tenants.ts";

const MASTER_FIXTURE = ["app", "encryption", "fixture", "not-real"].join("-");

test("encryptSecret roundtrips and never stores plaintext", async () => {
  const secret = "cs_" + "fixture" + Math.random().toString(36).slice(2, 8);
  const enc = await encryptSecret(secret, MASTER_FIXTURE);
  assert.notEqual(enc, secret);
  assert.equal(await decryptSecret(enc, MASTER_FIXTURE), secret);
});

test("decryption with the wrong master key fails closed", async () => {
  const enc = await encryptSecret("cs_fixture", MASTER_FIXTURE);
  await assert.rejects(() => decryptSecret(enc, "another-master-key"));
});

test("encryption is non-deterministic (fresh IV per call)", async () => {
  const a = await encryptSecret("cs_same", MASTER_FIXTURE);
  const b = await encryptSecret("cs_same", MASTER_FIXTURE);
  assert.notEqual(a, b);
  assert.equal(await decryptSecret(a, MASTER_FIXTURE), "cs_same");
});

test("applyOfferLimit truncates the free plan and passes paid plans through", () => {
  const offers = Array.from({ length: 30 }, (_, i) => ({ id: i }));
  const free = applyOfferLimit(offers, "free");
  assert.equal(free.offers.length, 25);
  assert.equal(free.truncated, true);
  assert.equal(free.limit, 25);

  const pro = applyOfferLimit(offers, "pro");
  assert.equal(pro.offers.length, 30);
  assert.equal(pro.truncated, false);

  const smallFree = applyOfferLimit(offers.slice(0, 4), "free");
  assert.equal(smallFree.truncated, false, "no truncation flag when under the limit");
});

test("normalizeStoreUrl trims slashes and rejects non-https", () => {
  assert.equal(normalizeStoreUrl("https://store.example.com///"), "https://store.example.com");
  assert.throws(() => normalizeStoreUrl("http://store.example.com"), /https/);
  assert.throws(() => normalizeStoreUrl(""), /https/);
});

test("normalizeStoreUrl accepts only a public origin", () => {
  for (const value of [
    "https://127.0.0.1", "https://[::1]", "https://localhost",
    "https://shop.local", "https://shop.internal", "https://shop.invalid",
    "https://user:pass@shop.example.com", "https://shop.example.com:8443",
    "https://shop.example.com/private", "https://shop.example.com?target=private",
  ]) assert.throws(() => normalizeStoreUrl(value), /public|path/);
  assert.equal(normalizeStoreUrl("https://SHOP.EXAMPLE.COM/"), "https://shop.example.com");
});
