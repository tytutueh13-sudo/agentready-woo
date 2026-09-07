// The site is served by two things: the Worker, and Cloudflare handing back a
// static asset without ever invoking it. Each needs its own copy of the
// security headers, which is exactly the arrangement that drifts — and drift
// here means a page's protection depends on which half answered it.
//
// This product shipped with neither copy: no CSP, no HSTS, no
// X-Content-Type-Options on any route, while both sibling services had them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secured } from "../src/index.ts";

const REQUIRED = [
  "content-security-policy",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
];

function workerHeaders(): Map<string, string> {
  const res = secured(new Response("hello"));
  return new Map([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
}

/** `/*` rules from the assets directory's _headers, as name -> value.
 *
 * Read from the path wrangler.toml actually serves. A first attempt put this
 * file in public/, which this project does not serve at all — it would have
 * passed a parity test and protected nothing. */
function staticHeaders(): Map<string, string> {
  const text = readFileSync(new URL("../marketing/landing/_headers", import.meta.url), "utf8");
  const out = new Map<string, string>();
  let inGlob = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    if (!line.startsWith(" ") && !line.startsWith("\t")) { inGlob = line.trim() === "/*"; continue; }
    if (!inGlob) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  return out;
}

test("the Worker sends every header the launch bar requires", () => {
  const headers = workerHeaders();
  for (const name of REQUIRED) {
    assert.ok(headers.has(name), `the Worker must send ${name}`);
  }
  assert.match(headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(headers.get("content-security-policy") ?? "", /object-src 'none'/);
});

test("the static half sends exactly the same headers as the Worker", () => {
  const worker = workerHeaders();
  const statics = staticHeaders();
  for (const name of REQUIRED) {
    assert.ok(statics.has(name), `marketing/landing/_headers must also send ${name}`);
    assert.equal(statics.get(name), worker.get(name),
      `${name} differs between the Worker and marketing/landing/_headers — a page's protection would depend on which half answered`);
  }
});

test("a route that set its own value keeps it", () => {
  // A narrower policy for one page knows something the blanket one does not,
  // so the wrapper fills gaps rather than overwriting.
  const res = secured(new Response("x", { headers: { "x-frame-options": "SAMEORIGIN" } }));
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.ok(res.headers.get("content-security-policy"), "and still adds the rest");
});

test("the payment allowance names Paddle, the only third party a buyer is handed to", () => {
  const csp = workerHeaders().get("content-security-policy") ?? "";
  assert.match(csp, /frame-src https:\/\/checkout\.paddle\.com/);
  assert.match(workerHeaders().get("permissions-policy") ?? "", /payment=\(self "https:\/\/checkout\.paddle\.com"\)/);
});

// The headers file only works from the directory wrangler serves. Put it
// anywhere else and every test still passes while the live site has nothing.
test("_headers sits in the directory wrangler.toml actually serves", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const dir = /\[assets\][\s\S]*?directory\s*=\s*"([^"]+)"/.exec(toml)?.[1];
  assert.ok(dir, "wrangler.toml must declare an assets directory");
  assert.doesNotThrow(
    () => readFileSync(new URL(`../${dir}/_headers`, import.meta.url), "utf8"),
    `_headers must live in ${dir}, the directory being served`,
  );
});

// A schedule belongs in the cron expression, not in a phase that reads the
// clock. These two have to agree, or the daily work runs on the wrong tick or
// on none at all.
test("wrangler.toml declares the daily trigger the code dispatches on", async () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const crons = /crons\s*=\s*\[([^\]]*)\]/.exec(toml)?.[1] ?? "";
  const declared = [...crons.matchAll(/"([^"]+)"/g)].map(m => m[1]);

  assert.ok(declared.length >= 2, `expected a frequent and a daily trigger, got ${JSON.stringify(declared)}`);
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const daily = /const DAILY_CRON = "([^"]+)"/.exec(source)?.[1];
  assert.ok(daily, "src/index.ts must name the daily cron");
  assert.ok(declared.includes(daily),
    `DAILY_CRON is "${daily}" but wrangler.toml declares ${JSON.stringify(declared)} — the phase would never fire`);
});

test("no scheduled phase picks its own moment by reading the minute", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const code = source.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/getUTCMinutes\(\)/.test(code),
    "a minute check inside a phase throws the whole tick away when an invocation starts late");
});
