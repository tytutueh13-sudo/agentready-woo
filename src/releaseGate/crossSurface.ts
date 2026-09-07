import type { ReleaseCheck } from "./types.ts";
export interface OfferFact { identifier: string; price?: string; currency?: string; stock?: string; source: string; }
export function crossSurfaceChecks(facts: readonly OfferFact[]): ReleaseCheck[] {
  const grouped = new Map<string, OfferFact[]>(); for (const fact of facts) grouped.set(fact.identifier, [...(grouped.get(fact.identifier) ?? []), fact]);
  let conflicts = 0; let sources = 0;
  for (const values of grouped.values()) { const prices = new Set(values.map(v => `${v.price ?? ""}|${v.currency ?? ""}`)); const stock = new Set(values.map(v => v.stock ?? "")); if (prices.size > 1 || stock.size > 1) conflicts++; sources += values.length; }
  return [{ id: "offer-consistency", family: "woo", state: conflicts ? "FAIL" : "PASS", ...(conflicts ? { reasonCode: "CROSS_SURFACE_CONFLICT" } : {}), evidence: { sampled_identifiers: grouped.size, conflicting_identifiers: conflicts, source_count: sources } }];
}
