import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const ENDPOINT = "https://app.utilityhouse.xyz/channels/github-marketplace/preflight";
export const FAMILIES = new Set(["woo", "robots", "jsonld", "mcp", "ucp", "acp"]);

export function parseInputs(env = process.env) {
  const rawOrigin = String(env["INPUT_STORE-ORIGIN"] ?? "").trim();
  let origin;
  try {
    const value = new URL(rawOrigin);
    if (value.protocol !== "https:" || value.username || value.password || value.pathname !== "/"
        || value.search || value.hash) throw new Error("origin only");
    origin = value.origin;
  } catch {
    throw new Error("store-origin must be a public HTTPS origin with no path, credentials, query or fragment");
  }
  const families = [...new Set(String(env.INPUT_FAMILIES ?? "woo,robots,jsonld,mcp,ucp,acp")
    .split(",").map(value => value.trim().toLowerCase()).filter(Boolean))];
  if (families.length === 0 || families.some(value => !FAMILIES.has(value))) {
    throw new Error("families must contain only woo, robots, jsonld, mcp, ucp or acp");
  }
  return { origin, families, failOnHold: String(env["INPUT_FAIL-ON-HOLD"] ?? "true").toLowerCase() === "true" };
}

export function decisionFor(state) {
  if (state === "ACCEPTED") return "RELEASE";
  if (state === "REJECTED") return "HOLD";
  if (state === "PARTIAL") return "PARTIAL";
  return "ABSTAIN";
}

function clean(value) { return String(value ?? "").replace(/[\r\n]/g, " "); }

export async function runAction({ env = process.env, fetchImpl = fetch, append = appendFile } = {}) {
  const input = parseInputs(env);
  const response = await fetchImpl(ENDPOINT, {
    method: "POST", headers: { "content-type": "application/json", "user-agent": "agentready-woo-action/1.2.0" },
    body: JSON.stringify({ store_origin: input.origin, requested_families: input.families }),
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* fail closed below */ }
  if (!response.ok) throw new Error(response.status === 429
    ? "AgentReady public rate limit reached; retry after the server's Retry-After window"
    : `AgentReady preflight unavailable (${response.status}; ${clean(payload.code || "NO_JSON")})`);
  const state = clean(payload.state || "UNMEASURED");
  const decision = decisionFor(state);
  const unknowns = Array.isArray(payload.unknowns) ? payload.unknowns.map(clean) : [];
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  const output = [
    `decision=${decision}`, `state=${state}`, `observed-at=${clean(payload.observed_at)}`,
    `unknowns=${JSON.stringify(unknowns)}`,
  ].join("\n") + "\n";
  if (env.GITHUB_OUTPUT) await append(env.GITHUB_OUTPUT, output, "utf8");
  const table = checks.map(check => `| ${clean(check.family)} | ${clean(check.state)} | ${clean(check.reasonCode || check.id)} |`).join("\n");
  const summary = `## AgentReady Woo preflight\n\n**${decision}** — server state \`${state}\`\n\n`
    + `Store: \`${input.origin}\`  \nObserved: ${clean(payload.observed_at || "unavailable")}\n\n`
    + `| Family | State | Evidence / reason |\n|---|---|---|\n${table || "| — | UNMEASURED | No checks returned |"}\n\n`
    + `BLOCKED and UNMEASURED are abstentions, not store failures. The action changes nothing on the store.\n`;
  if (env.GITHUB_STEP_SUMMARY) await append(env.GITHUB_STEP_SUMMARY, summary, "utf8");
  if (decision === "HOLD" && input.failOnHold) throw new Error("AgentReady returned HOLD from explicit failed evidence");
  return { decision, state, unknowns, checks };
}

const isDirectEntrypoint = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (process.env.GITHUB_ACTIONS === "true" && isDirectEntrypoint) {
  runAction().catch(error => { process.stderr.write(`::error::${clean(error.message)}\n`); process.exitCode = 1; });
}
