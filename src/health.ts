// Operating endpoints (section 45). No internal data exposed — status only.
export interface HealthPayload {
  status: "healthy";
  service: string;
  version: string;
  timestamp: string;
  artifactHash: string;
}

export interface StatusPayload {
  status: "healthy" | "degraded";
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
    status: revenueSystemEnabled && productEnabled ? "healthy" : "degraded",
    service: serviceName, version, timestamp: new Date().toISOString(),
    revenueSystemEnabled, productEnabled,
    artifactHash: artifactHash(env),
    paymentMode: stringValue("MONEYAI_PAYMENT_MODE") || "none",
    revenueGuardState: revenueSystemEnabled && productEnabled ? "healthy" : "disabled",
    budgetState: revenueSystemEnabled && productEnabled ? "healthy" : "disabled",
    d1ConcurrencyVerified, x402InteropVerified,
    note: "This reports the experimental x402 per-call payment rail for the " +
      "readiness-scan tool only. The store-scanning product and its Paddle " +
      "billing are a separate system and are unaffected by this status.",
  };
}
