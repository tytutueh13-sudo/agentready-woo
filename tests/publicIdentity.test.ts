import test from "node:test";
import assert from "node:assert/strict";
import { health, status } from "../src/health.ts";
import {
  AGENTREADY_PUBLIC_NAME, AGENTREADY_SERVER_NAME, AGENTREADY_VERSION,
} from "../src/productIdentity.ts";

test("public health identity never exposes the durable AgentReady product key", () => {
  const env = {
    "PRODUCT_early-3426536d88daa242_ENABLED": "true",
    REVENUE_SYSTEM_ENABLED: "true",
  };
  const publicHealth = health(AGENTREADY_PUBLIC_NAME, AGENTREADY_VERSION, env);
  const publicStatus = status(AGENTREADY_PUBLIC_NAME, AGENTREADY_VERSION, env, "early-3426536d88daa242");

  assert.equal(publicHealth.service, AGENTREADY_PUBLIC_NAME);
  assert.equal(publicHealth.version, "1.2.0");
  assert.equal(publicStatus.service, AGENTREADY_PUBLIC_NAME);
  assert.equal(publicStatus.version, publicHealth.version);
  assert.equal(AGENTREADY_SERVER_NAME, "agentready-woo");
  assert.equal(publicStatus.productEnabled, true);
  assert.equal(publicStatus.status, "healthy");
  assert.equal(publicStatus.coreStatus, "healthy");
  assert.equal(publicStatus.experimentalSettlementStatus, "enabled");
  assert.doesNotMatch(JSON.stringify({ publicHealth, publicStatus }), /early-3426536d88daa242/);
});

test("disabled experimental settlement does not degrade the working core product", () => {
  const publicStatus = status(AGENTREADY_PUBLIC_NAME, AGENTREADY_VERSION, {
    REVENUE_SYSTEM_ENABLED: "true",
  }, "early-3426536d88daa242");
  assert.equal(publicStatus.status, "healthy");
  assert.equal(publicStatus.coreStatus, "healthy");
  assert.equal(publicStatus.experimentalSettlementStatus, "disabled");
  assert.match(publicStatus.note, /intentional commercial state/i);
});

test("Cloudflare version metadata is the deployed artifact identity", () => {
  const env = { CF_VERSION_METADATA: { id: "version-123" }, MONEYAI_ARTIFACT_HASH: "legacy" };
  assert.equal(health(AGENTREADY_PUBLIC_NAME, AGENTREADY_VERSION, env).artifactHash, "version-123");
  assert.equal(status(AGENTREADY_PUBLIC_NAME, AGENTREADY_VERSION, env).artifactHash, "version-123");
});
