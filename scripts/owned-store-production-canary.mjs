#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appOrigin = (process.env.AGENTREADY_APP_ORIGIN ?? "https://app.utilityhouse.xyz").replace(/\/+$/, "");
const storeOrigin = (process.env.AGENTREADY_CANARY_STORE_ORIGIN ?? "").replace(/\/+$/, "");
if (!/^https:\/\//.test(storeOrigin)) {
  throw new Error("AGENTREADY_CANARY_STORE_ORIGIN must be a temporary HTTPS WooCommerce store");
}

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = resolve(serviceRoot, "wordpress-plugin/agentready-woo/integration/docker-compose.yml");
const dockerPath = `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH ?? ""}`;
const suffix = `${Date.now()}-${randomBytes(5).toString("hex")}`;
const email = `agentready-canary-${suffix}@example.invalid`;
const password = `Canary-${randomBytes(24).toString("base64url")}!`;
let sessionCookie = "";
let accountCreated = false;

function form(values) {
  return new URLSearchParams(values).toString();
}

async function checkedFetch(path, options, expected) {
  const response = await fetch(`${appOrigin}${path}`, { redirect: "manual", ...options });
  const accepted = Array.isArray(expected) ? expected : [expected];
  if (!accepted.includes(response.status)) {
    throw new Error(`${options?.method ?? "GET"} ${path} failed with HTTP ${response.status}`);
  }
  return response;
}

async function json(response) {
  return await response.json();
}

function authenticatedHeaders(extra = {}) {
  return { cookie: sessionCookie, origin: appOrigin, ...extra };
}

function configurePluginAndPublishEvidence(bundle) {
  const command = [
    "set -euo pipefail",
    'WP="wp --allow-root --path=/var/www/html"',
    '$WP option update agentready_woo_worker_url "$ARW_ENDPOINT" >/dev/null',
    '$WP option update agentready_woo_release_store_id "$ARW_STORE_ID" >/dev/null',
    '$WP option update agentready_woo_release_gate_key "$ARW_OWNERSHIP_KEY" >/dev/null',
    '$WP option update agentready_woo_release_evidence_current "$ARW_EVIDENCE_KEY" >/dev/null',
    '$WP option update agentready_woo_release_evidence_key_id current >/dev/null',
    "$WP rewrite flush --hard >/dev/null 2>&1 || true",
    "$WP eval 'if (!AgentReady_Woo::run_release_evidence()) { exit(2); }'",
  ].join("; ");
  const result = spawnSync("docker", [
    "compose", "-f", composeFile,
    "run", "--rm", "--no-deps", "--entrypoint", "/bin/bash",
    "-e", "ARW_ENDPOINT", "-e", "ARW_STORE_ID", "-e", "ARW_OWNERSHIP_KEY", "-e", "ARW_EVIDENCE_KEY",
    "wordpress", "-lc", command,
  ], {
    cwd: serviceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: dockerPath,
      ARW_ENDPOINT: bundle.endpoint,
      ARW_STORE_ID: bundle.store_id,
      ARW_OWNERSHIP_KEY: bundle.ownership_key,
      ARW_EVIDENCE_KEY: bundle.evidence_key,
    },
  });
  if (result.status !== 0) throw new Error(`WordPress evidence publisher failed with exit ${result.status ?? "unknown"}`);
}

async function deleteCanaryAccount() {
  if (!accountCreated || !sessionCookie) return false;
  const response = await fetch(`${appOrigin}/dashboard/account/delete`, {
    method: "POST",
    redirect: "manual",
    headers: authenticatedHeaders({ "content-type": "application/x-www-form-urlencoded" }),
    body: form({ delete_password: password }),
  });
  return response.status === 302 && response.headers.get("location") === "/login";
}

let cleanupSucceeded = false;
try {
  const signup = await checkedFetch("/signup", {
    method: "POST",
    headers: { origin: appOrigin, "content-type": "application/x-www-form-urlencoded" },
    body: form({ email, password, accept_terms: "on" }),
  }, 302);
  const setCookie = signup.headers.get("set-cookie") ?? "";
  const session = setCookie.match(/arw_session=([^;]+)/)?.[1];
  if (!session) throw new Error("signup did not issue a session cookie");
  sessionCookie = `arw_session=${session}`;
  accountCreated = true;

  await checkedFetch("/dashboard/store", {
    method: "POST",
    headers: authenticatedHeaders({ "content-type": "application/x-www-form-urlencoded" }),
    body: form({
      name: "Owned-store production canary",
      store_url: storeOrigin,
      consumer_key: `ck_${randomBytes(20).toString("hex")}`,
      consumer_secret: `cs_${randomBytes(20).toString("hex")}`,
    }),
  }, 302);

  const dashboard = await checkedFetch("/dashboard", { headers: authenticatedHeaders() }, 200);
  const dashboardHtml = await dashboard.text();
  const storeId = dashboardHtml.match(/\/dashboard\/store\/([a-f0-9-]{36})/)?.[1];
  if (!storeId) throw new Error("connected store was not visible in the dashboard");

  const credentialResponse = await checkedFetch(`/api/v2/stores/${storeId}/release-credentials`, {
    method: "POST",
    headers: authenticatedHeaders(),
  }, 200);
  if (credentialResponse.headers.get("cache-control") !== "no-store") {
    throw new Error("connection bundle was not marked no-store");
  }
  const bundle = await json(credentialResponse);
  for (const key of ["store_id", "endpoint", "ownership_key", "evidence_key"]) {
    if (typeof bundle[key] !== "string" || !bundle[key]) throw new Error(`connection bundle omitted ${key}`);
  }
  configurePluginAndPublishEvidence(bundle);

  const challenge = await json(await checkedFetch(`/api/v2/stores/${storeId}/ownership-challenges`, {
    method: "POST",
    headers: authenticatedHeaders(),
  }, 201));
  const proofResponse = await fetch(`${storeOrigin}/.well-known/agentready-ownership?challenge=${encodeURIComponent(challenge.challenge)}`, {
    headers: { origin: appOrigin },
  });
  if (proofResponse.status !== 200 || proofResponse.headers.get("cache-control") !== "no-store") {
    throw new Error(`public ownership proof failed with HTTP ${proofResponse.status}`);
  }
  if (proofResponse.headers.get("access-control-allow-origin") !== appOrigin) {
    throw new Error("public ownership proof did not permit the exact dashboard origin");
  }
  const proof = await proofResponse.json();
  const verified = await json(await checkedFetch(`/api/v2/stores/${storeId}/ownership-challenges/${challenge.challenge_id}/verify`, {
    method: "POST",
    headers: authenticatedHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ challenge: challenge.challenge, proof: proof.proof }),
  }, 200));
  if (verified.verified !== true) throw new Error("ownership verification did not pass");

  const started = await json(await checkedFetch("/api/v2/acceptance-runs", {
    method: "POST",
    headers: authenticatedHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      store_id: storeId,
      mode: "owned-safe-active",
      requested_families: ["woo"],
      idempotency_key: `canary_${randomBytes(16).toString("hex")}`,
    }),
  }, 202));
  if (started.settlement !== "disabled") throw new Error("settlement unexpectedly enabled at run start");

  let run;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    run = await json(await checkedFetch(`/api/v2/acceptance-runs/${started.run_id}`, {
      headers: authenticatedHeaders(),
    }, 200));
    if (run.state === "TERMINAL") break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  if (run?.state !== "TERMINAL" || run.terminal_state !== "ACCEPTED") {
    throw new Error(`acceptance run did not finish ACCEPTED (${run?.state ?? "unknown"}/${run?.terminal_state ?? "unknown"})`);
  }

  const claim = async () => json(await checkedFetch(`/api/v2/acceptance-runs/${started.run_id}/claim-result`, {
    method: "POST",
    headers: authenticatedHeaders(),
  }, 200));
  const first = await claim();
  const replay = await claim();
  if (first.delivery !== "FIRST" || first.billable_eligibility !== "ELIGIBLE_ON_FIRST_DELIVERY" || first.settlement !== "disabled") {
    throw new Error("first-delivery billing contract failed");
  }
  if (replay.delivery !== "REPLAY" || replay.billable_eligibility !== "NOT_BILLABLE" || replay.settlement !== "disabled") {
    throw new Error("replay billing contract failed");
  }

  console.log(JSON.stringify({
    public_discovery: "PASS",
    signed_aggregate_evidence: "PASS",
    ownership_verification: "PASS",
    acceptance_decision: "ACCEPTED",
    first_delivery_eligibility: "ELIGIBLE_ON_FIRST_DELIVERY",
    replay_eligibility: "NOT_BILLABLE",
    settlement: "disabled",
  }, null, 2));
} finally {
  cleanupSucceeded = await deleteCanaryAccount().catch(() => false);
  if (accountCreated && !cleanupSucceeded) {
    console.error("CANARY_ACCOUNT_CLEANUP_FAILED");
    process.exitCode = 2;
  } else if (accountCreated) {
    console.error("CANARY_ACCOUNT_CLEANUP_OK");
  }
}
