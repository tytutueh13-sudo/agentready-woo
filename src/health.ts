// Operating endpoints (section 45). No internal data exposed — status only.
export interface HealthPayload {
  status: "healthy";
  service: string;
  version: string;
  timestamp: string;
  artifactHash: string;
}

export interface StatusPayload {
  status: "healthy";
  coreStatus: "healthy";
  coreProductEnabled: true;
  experimentalSettlementStatus: "enabled" | "disabled";
  experimentalSettlementProductEnabled: boolean;
  service: string;
  version: string;
  timestamp: string;
  revenueSystemEnabled: boolean;
  productEnabled: boolean;
  artifactHash: string;
  paymentMode: string;
  revenueGuardState: "healthy" | "disabled";
  budgetState: "healthy" | "disabled";
  d1ConcurrencyVerified: boolean;
  x402InteropVerified: boolean;
  note: string;
}

type HealthEnv = Record<string, unknown> & {
  MONEYAI_ARTIFACT_HASH?: string;
  CF_VERSION_METADATA?: { id?: string };
};

function artifactHash(env: HealthEnv): string {
  return env.CF_VERSION_METADATA?.id ?? env.MONEYAI_ARTIFACT_HASH ?? "";
}

export function health(serviceName: string, version: string,
  env: HealthEnv): HealthPayload {
  return { status: "healthy", service: serviceName, version, timestamp: new Date().toISOString(),
    artifactHash: artifactHash(env) };
}

export function status(serviceName: string, version: string,
  env: HealthEnv, productFlagKey = serviceName): StatusPayload {
  const stringValue = (key: string): string => typeof env[key] === "string" ? env[key] as string : "";
  const revenueSystemEnabled = stringValue("REVENUE_SYSTEM_ENABLED").trim().toLowerCase() === "true";
  const productFlag = stringValue(`PRODUCT_${productFlagKey}_ENABLED`) || undefined;
  const productEnabled = productFlag !== undefined && productFlag.trim().toLowerCase() === "true";
  const d1ConcurrencyVerified = stringValue("D1_REAL_CONCURRENCY_VERIFIED").trim().toLowerCase() === "true";
  const x402InteropVerified = stringValue("X402_WIRE_INTEROP_VERIFIED").trim().toLowerCase() === "true";
  return {
    // The public scan and Release Gate control plane are the product. The
    // legacy x402 switch is an experimental settlement rail, so disabling it
    // must not report the whole product as degraded.
    status: "healthy",
    coreStatus: "healthy",
    coreProductEnabled: true,
    experimentalSettlementStatus: revenueSystemEnabled && productEnabled ? "enabled" : "disabled",
    experimentalSettlementProductEnabled: productEnabled,
    service: serviceName, version, timestamp: new Date().toISOString(),
    revenueSystemEnabled, productEnabled,
    artifactHash: artifactHash(env),
    paymentMode: stringValue("MONEYAI_PAYMENT_MODE") || "none",
    revenueGuardState: revenueSystemEnabled && productEnabled ? "healthy" : "disabled",
    budgetState: revenueSystemEnabled && productEnabled ? "healthy" : "disabled",
    d1ConcurrencyVerified, x402InteropVerified,
    note: "Core public preflight and owner-authorized Release Gate services are healthy. " +
      "productEnabled is a legacy alias for experimentalSettlementProductEnabled; " +
      "disabled is an intentional commercial state for x402, not a product outage.",
  };
}
