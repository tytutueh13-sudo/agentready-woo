// The public mirror is what an MCP directory reviewer and wordpress.org read —
// both server manifests point at it by URL. It went stale once already: it
// still advertises one x402-gated tool and "not the full JSON-RPC 2.0 protocol"
// while production answers tools/list with five tools over JSON-RPC 2.0.
//
// These pin the boundary itself, so the next drift is a failing test rather
// than a reviewer's discovery.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** The builder and the staging package are deliberately withheld from the
 * mirror — "the boundary itself is not part of what crosses it" — so these
 * assertions have nothing to read there. */
function withheld(): boolean {
  try { readFileSync(join(ROOT, BUILDER), "utf8"); return false; } catch { return true; }
}
const SKIP = "public mirror: the staging boundary is withheld";
const BUILDER = "scripts/build-public-repo.py";

test("the builder withholds every internal directory by name", (t) => {
  if (withheld()) return t.skip(SKIP);
  const source = text(BUILDER);
  for (const withheld of ["registration-handoff", "marketing/unlicensed-hold",
                          "docs", "output", "node_modules"]) {
    assert.match(source, new RegExp(`"${withheld}":`),
      `${withheld} is not in the exclude list, so it would be published`);
  }
  // the exclusions carry reasons, because a bare list rots into folklore
  assert.equal(/"[^"]+": "[^"]+"/.test(source), true);
});

test("the builder refuses to stage a real database id, key or dead host", (t) => {
  if (withheld()) return t.skip(SKIP);
  const source = text(BUILDER);
  // The real database id is read out of wrangler.toml rather than written
  // here. A test that hardcodes it becomes a file the staging guard refuses to
  // publish — which is exactly the guard working, and exactly the wrong way to
  // assert that it works.
  const realDatabaseId = /database_id\s*=\s*"([0-9a-f-]{36})"/.exec(text("wrangler.toml"))?.[1];
  assert.ok(realDatabaseId, "wrangler.toml no longer declares a database_id");
  assert.ok(source.includes(realDatabaseId), "the scanner does not name the real database id");
  for (const guarded of ["PRIVATE KEY", "utilityhouse", "Bearer"]) {
    assert.ok(source.includes(guarded), `the scanner does not name ${guarded}`);
  }
  assert.match(source, /REFUSING to stage/,
    "a finding must stop the build, not warn and continue");
  assert.match(source, /shutil\.rmtree\(dest\)/,
    "a refused stage must leave nothing behind to push by accident");
});

test("a silenced scanner is visible in review, not buried in a pattern", (t) => {
  if (withheld()) return t.skip(SKIP);
  const source = text(BUILDER);
  assert.match(source, /ALLOW_NAMED = \{/);
  assert.match(source, /allowed  \{note\}|allowed  /,
    "an allowed exception must be printed when it is used");
});

test("the README the mirror ships states the product truth", (t) => {
  if (withheld()) return t.skip(SKIP);
  const readme = text("registration-handoff/public-repo-staging/README.md.new");
  assert.match(readme, /JSON-RPC 2\.0/);
  assert.match(readme, /five tools/i);
  assert.match(readme, /settlement is disabled/i);
  assert.match(readme, /state: `?UNREADABLE`?|`state: UNREADABLE`/);
  assert.match(readme, /unmeasured/i);
  assert.match(readme, /3 calls per target origin per day|three calls per target origin/i);
  // the claims the old README made that production contradicts
  assert.equal(/not the full JSON-RPC/i.test(readme), false);
  assert.equal(/single global.*payment-gated tool/i.test(readme), false);
  assert.equal(/buy from/i.test(readme), false);
});

test("the apply checklist names the base commit and forbids pushing", (t) => {
  if (withheld()) return t.skip(SKIP);
  const apply = text("registration-handoff/public-repo-staging/APPLY.md");
  assert.match(apply, /e83aa9e/, "an apply step without a base is not reproducible");
  assert.match(apply, /Nothing has been pushed/i);
  assert.match(apply, /397 passing, 21 skipped/,
    "the expected test outcome must be stated so a different one is noticed");
});

test("the builder is executable and its destination is its only output", (t) => {
  if (withheld()) return t.skip(SKIP);
  assert.ok(existsSync(join(ROOT, BUILDER)));
  const source = text(BUILDER);
  assert.equal(/subprocess|os\.system|git push|requests\./.test(source), false,
    "the builder must not run git, shell out, or reach the network");
});
