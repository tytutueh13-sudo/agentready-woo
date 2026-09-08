import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { pluginEvidenceChecks } from "../src/releaseGate/signedEvidence.ts";
import type { PluginEvidence } from "../src/releaseGate/pluginEvidence.ts";

const classPath = fileURLToPath(new URL("../wordpress-plugin/agentready-woo/includes/class-agentready-woo.php", import.meta.url));
const mainPath = fileURLToPath(new URL("../wordpress-plugin/agentready-woo/agentready-woo.php", import.meta.url));
const zipPath = fileURLToPath(new URL("../marketing/landing/downloads/agentready-woo.zip", import.meta.url));
const packagerPath = fileURLToPath(new URL("../scripts/package-wordpress-plugin.py", import.meta.url));

function phpRollup(productCount: number | null): { state: string; count: number } {
  const wooStub = productCount === null ? "" : `function wc_get_products($args){ return array_fill(0, ${productCount}, 1); }`;
  const run = spawnSync("php", ["-r", `define('ABSPATH', __DIR__); define('AGENTREADY_WOO_VERSION','1.1.0'); ${wooStub} require $argv[1]; echo json_encode(AgentReady_Woo::release_woo_rollup());`, classPath], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as { state: string; count: number };
}

test("the production Woo rollup abstains without Woo and rejects an empty catalogue", () => {
  assert.deepEqual(phpRollup(null), { state: "UNMEASURED", count: 0 });
  assert.deepEqual(phpRollup(0), { state: "FAIL", count: 0 });
  assert.deepEqual(phpRollup(1), { state: "PASS", count: 1 });
});

test("an empty signed Woo rollup carries the specific empty-sample reason", () => {
  const packet = {
    schema_version: "2026-09-06", store_id: "store_aaaa", generated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(), nonce: "nonce_aaaaaaaa", key_id: "current",
    collector_version: "1.1.0", families: ["woo"], checks: { woo_rollup: { state: "FAIL", count: 0 } },
    digest: "a".repeat(64),
  } satisfies PluginEvidence;
  assert.equal(pluginEvidenceChecks(packet, ["woo"])[0]?.reasonCode, "WOO_SAMPLE_EMPTY");
});

test("WordPress registration uses a serializable uninstall callback and never renders stored keys", () => {
  const main = readFileSync(mainPath, "utf8");
  const implementation = readFileSync(classPath, "utf8");
  assert.match(main, /register_uninstall_hook\( __FILE__, array\( 'AgentReady_Woo', 'uninstall_release_evidence' \) \)/);
  assert.doesNotMatch(main, /register_uninstall_hook\( __FILE__, function/);
  assert.doesNotMatch(implementation, /value="<\?php echo esc_attr\( \$ownership_key \); \?>"/);
  assert.match(implementation, /Ownership key \(leave blank to keep\)/);
  for (const option of ["OPTION_WORKER_URL", "OPTION_OWNERSHIP_KEY", "OPTION_RELEASE_STORE_ID", "OPTION_RELEASE_CURRENT_KEY", "OPTION_RELEASE_PREVIOUS_KEY", "OPTION_RELEASE_KEY_ID"]) {
    assert.match(implementation, new RegExp(`uninstall_release_evidence\\(\\).*?${option}`, "s"), `${option} must be removed on uninstall`);
  }
  assert.match(implementation, /allow_dashboard_origin/);
  assert.match(implementation, /\$origin !== \$expected/);
  assert.doesNotMatch(implementation, /Access-Control-Allow-Origin:\s*\*/);
});

test("the public plugin package is deterministic and contains only the runtime files", () => {
  const digest = () => createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  const before = digest();
  const built = spawnSync("python3", [packagerPath], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  assert.equal(digest(), before);
  const listing = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.trim().split("\n"), [
    "agentready-woo/agentready-woo.php",
    "agentready-woo/includes/class-agentready-woo.php",
    "agentready-woo/readme.txt",
  ]);
});
