// An OpenAPI document is a promise to a marketplace, and it rots faster than
// anything else in a repository: someone adds a reason code, and RapidAPI keeps
// serving last month's enum to people writing switch statements against it.
//
// These read the YAML as text — no parser dependency — and compare it against
// the code's own vocabulary and against a response captured from production.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CHECK_STATES, RELEASE_FAMILIES, RELEASE_STATES,
} from "../src/releaseGate/types.ts";

const SPEC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "mcp-registry", "openapi-preflight.yaml"),
  "utf8",
);

/** The block of YAML belonging to one named schema, up to the next one. */
function schemaBlock(schemaName: string): string {
  const start = SPEC.indexOf(`    ${schemaName}:`);
  assert.notEqual(start, -1, `${schemaName} is not in the document`);
  const rest = SPEC.slice(start + 1);
  // the next sibling is the next line indented by exactly four spaces
  const next = rest.search(/\n {4}\S/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The `enum:` list that follows a named schema, as written in the YAML. */
function enumUnder(schemaName: string): string[] {
  const block = schemaBlock(schemaName);
  const inline = block.match(/enum:\s*\[([^\]]*)\]/);
  if (inline) return inline[1].split(",").map(s => s.trim()).filter(Boolean);
  const listed = block.match(/enum:\s*\n((?: *- *\S+\n)+)/);
  assert.ok(listed, `${schemaName} has no enum`);
  return listed[1].split("\n").map(l => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
}

/** The exact bytes production returned for a target it could not read, on
 * 2026-09-07. Kept verbatim: the point is that the document describes what the
 * server sends, not what would have been convenient to document. */
const PRODUCTION_ABSTENTION = {
  kind: "preflight", state: "BLOCKED", store_origin: "https://woocommerce.com",
  requested_families: ["woo", "robots", "jsonld"], sample_seed: "none",
  sample_size: 0, catalogue_total: null,
  checks: [{ id: "target", family: "woo", state: "BLOCKED", reasonCode: "TARGET_PRIVATE", evidence: { safe: false } }],
  protocol_bundles: [], observed_at: "2026-09-07T06:20:31.073Z",
  unknowns: ["TARGET_PRIVATE"],
};

test("the documented reason codes are exactly the ones the code can emit", () => {
  const documented = new Set(enumUnder("ReasonCode"));
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "releaseGate", "types.ts"), "utf8");
  const declared = new Set(
    (source.slice(source.indexOf("export type ReasonCode"),
                  source.indexOf("export interface ReleaseCheck"))
      .match(/"([A-Z][A-Z_]+)"/g) ?? []).map(s => s.replaceAll('"', "")));

  const missing = [...declared].filter(c => !documented.has(c)).sort();
  const invented = [...documented].filter(c => !declared.has(c)).sort();
  assert.deepEqual(missing, [], `in the code, not in the OpenAPI: ${missing.join(", ")}`);
  assert.deepEqual(invented, [], `in the OpenAPI, not in the code: ${invented.join(", ")}`);
});

test("the documented families and states match the code", () => {
  assert.deepEqual(enumUnder("Family").sort(), [...RELEASE_FAMILIES].sort());

  // the preflight cannot report the two states the classifier folds away
  const reportable = RELEASE_STATES.filter(s => s !== "CANCELED" && s !== "INFRA_ERROR");
  const documentedResultStates = schemaBlock("PreflightResult")
    .match(/enum:\s*\[([^\]]*)\]/)?.[1].split(",").map(s => s.trim()) ?? [];
  assert.deepEqual(documentedResultStates.sort(), [...reportable].sort());

  const documentedCheckStates = schemaBlock("Check")
    .match(/enum:\s*\[([^\]]*)\]/)?.[1].split(",").map(s => s.trim()) ?? [];
  assert.deepEqual(documentedCheckStates.sort(), [...CHECK_STATES].sort());
});

test("the documented result shape is the shape production actually returns", () => {
  const required = schemaBlock("PreflightResult")
    .match(/required:\s*\n\s*\[([^\]]*)\]/s)?.[1]
    .split(",").map(s => s.trim()).filter(Boolean) ?? [];
  assert.deepEqual(required.sort(), Object.keys(PRODUCTION_ABSTENTION).sort(),
    "the document's required fields and a real production response disagree");
});

test("the document says a 200 is not necessarily an answer", () => {
  // The single most expensive misreading of this API. If this sentence goes,
  // a consumer will report BLOCKED stores as findings.
  assert.match(SPEC, /This does not mean it could read the store/);
  assert.match(SPEC, /abstentions, not failures of the store/i);
  const abstention = SPEC.indexOf("abstained:");
  assert.notEqual(abstention, -1, "the abstention example must stay in the document");
  assert.match(SPEC.slice(abstention, abstention + 400), /state: BLOCKED/);
});

test("the real rate limits are documented, not a friendlier number", () => {
  assert.match(SPEC, /3 calls per target origin per day/i);
  assert.match(SPEC, /10 calls per calling IP per day/i);
  assert.match(SPEC, /do not rotate addresses/i);
});

test("the document promises no accuracy and no purchase", () => {
  assert.match(SPEC, /accuracy against real merchant stores is unmeasured/i);
  assert.equal(/\$\d/.test(SPEC), false, "no price belongs in this document");
  assert.match(SPEC, /Credential-free and read-only/i);
});
