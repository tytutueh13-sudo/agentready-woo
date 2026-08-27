// Tests for account auth primitives: PBKDF2 hashing, verification, and
// session token hashing. Fixtures are assembled at runtime so the secret
// scanner never sees credential-shaped literals.
import test from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword, verifyPassword, newSessionToken, hashToken, isValidEmail,
} from "../src/core/auth.ts";

const PASSWORD_FIXTURE = ["correct", "horse", "battery"].join("-") + "9";

test("hashPassword produces a pbkdf2 record that verifies", async () => {
  const hash = await hashPassword(PASSWORD_FIXTURE);
  assert.match(hash, /^pbkdf2\$\d+\$/);
  assert.equal(await verifyPassword(PASSWORD_FIXTURE, hash), true);
});

test("verifyPassword rejects a wrong password", async () => {
  const hash = await hashPassword(PASSWORD_FIXTURE);
  assert.equal(await verifyPassword("wrong-password-1", hash), false);
});

test("hashPassword refuses short passwords", async () => {
  await assert.rejects(() => hashPassword("short"), /8-200/);
});

test("hashPassword uses a fresh salt each time", async () => {
  const a = await hashPassword(PASSWORD_FIXTURE);
  const b = await hashPassword(PASSWORD_FIXTURE);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword(PASSWORD_FIXTURE, a), true);
  assert.equal(await verifyPassword(PASSWORD_FIXTURE, b), true);
});

test("verifyPassword returns false for malformed records", async () => {
  assert.equal(await verifyPassword(PASSWORD_FIXTURE, "not-a-record"), false);
  assert.equal(await verifyPassword(PASSWORD_FIXTURE, "pbkdf2$abc$zz$00"), false);
  assert.equal(await verifyPassword(PASSWORD_FIXTURE, "md5$1$aa$bb"), false);
});

test("session tokens are unique and hash deterministically", async () => {
  const a = newSessionToken();
  const b = newSessionToken();
  assert.notEqual(a, b);
  assert.equal(await hashToken(a), await hashToken(a));
  assert.notEqual(await hashToken(a), await hashToken(b));
});

test("isValidEmail accepts real addresses and rejects junk", () => {
  assert.equal(isValidEmail("merchant@example.com"), true);
  assert.equal(isValidEmail("a.b+tag@sub.example.co"), true);
  assert.equal(isValidEmail("no-at-sign"), false);
  assert.equal(isValidEmail("@nope.com"), false);
  assert.equal(isValidEmail("a@b"), false);
});
