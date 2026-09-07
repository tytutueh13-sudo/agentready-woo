import type { ProtocolBundle } from "./types.ts";

/** Reviewed immutable manifests. `sourceSha256` is the SHA-256 of the exact
 * vendored review manifest, not an assertion about a mutable web page. */
export const PROTOCOL_BUNDLES: readonly ProtocolBundle[] = [
  { family: "mcp", release: "2025-06-18", sourceUrl: "https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-06-18/schema.json", sourceSha256: "af845e7e5b9d27107d1690f0936022546177a1403e63ffb11470135b296a2e01", vectorSha256: "404ad329fc4b3059b35a202262ef2d1333c33373de5fe0365fa35d0b77c4b912", builtAt: "2026-09-06T00:00:00.000Z", supportedVectors: ["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"], unsupportedVectors: ["resources", "prompts", "sampling"] },
  { family: "ucp", release: "2026-08-25", sourceUrl: "https://ucp.dev/2026-08-25/llms.txt", sourceSha256: "9bc65f401b227831474fc6d64f650ceacf2be1d16e6e7e3cf6a941ce3c340873", vectorSha256: "b0cca095bc10c14dcefb8586e825a430de542ce72b4d96ce88e5434f58b599a4", builtAt: "2026-09-06T00:00:00.000Z", supportedVectors: ["profile-version", "capability-declaration", "non-payment-cart"], unsupportedVectors: ["payment", "native-checkout"] },
  { family: "acp", release: "2026-04-17", sourceUrl: "https://raw.githubusercontent.com/agentic-commerce-protocol/agentic-commerce-protocol/main/spec/2026-04-17/openapi/openapi.agentic_checkout.yaml", sourceSha256: "2a0aa239b4aed50732461d9b7e443ad98d5c2d3431277899433ead07cbd4fc55", vectorSha256: "ed56168b531aeca448a11debe0021669a8a904b8e34af614714f1efc2e8b54ea", builtAt: "2026-09-06T00:00:00.000Z", supportedVectors: ["profile-schema", "feed-schema", "non-payment-state"], unsupportedVectors: ["payment-authorization", "partner-conformance"] },
];
export function bundlesFor(families: readonly string[]): ProtocolBundle[] { return PROTOCOL_BUNDLES.filter(b => families.includes(b.family)); }
export async function bundleDigest(bundles: readonly ProtocolBundle[] = PROTOCOL_BUNDLES): Promise<string> {
  const canonical = JSON.stringify([...bundles].sort((a, b) => a.family.localeCompare(b.family)));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)))].map(v => v.toString(16).padStart(2, "0")).join("");
}
