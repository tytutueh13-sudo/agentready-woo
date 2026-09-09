import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL(
  "../wordpress-plugin/agentready-woo/blueprints/blueprint.json",
  import.meta.url,
));
const blueprint = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

test("the Playground demo is pinned, local-first and activation-safe", () => {
  assert.equal(blueprint.$schema, "https://playground.wordpress.net/blueprint-schema.json");
  assert.equal(blueprint.landingPage, "/wp-admin/admin.php?page=agentready-woo");
  assert.equal(blueprint.login, true);
  const steps = blueprint.steps as Array<Record<string, unknown>>;
  const installs = steps.filter(step => step.step === "installPlugin");
  assert.equal(installs.length, 2);
  const plugin = installs[1]?.pluginData as Record<string, unknown>;
  assert.deepEqual(plugin, {
    resource: "git:directory",
    url: "https://github.com/tytutueh13-sudo/agentready-woo",
    path: "wordpress-plugin/agentready-woo",
    ref: "v1.2.0",
    refType: "tag",
  });
  const serialized = JSON.stringify(blueprint);
  assert.equal(/app\.utilityhouse\.xyz|release_evidence_enabled|worker_url/.test(serialized), false,
    "a disposable demo must not configure or contact the Release Gate service");
});
