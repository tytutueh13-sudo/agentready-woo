// Hard Budget (section 16). One check() serves both QUOTA CHECK (cost=0, a
// pre-flight "are we already over budget?") and BUDGET CHECK (the real
// estimated cost) in the call order — same design as src/revenue/quota.py.
import type { RevenueGuardConfig } from "./pricing.ts";
import type { Store } from "./types.ts";

export interface BudgetDecision {
  allowed: boolean;
  reason: string;
}

export class QuotaTracker {
  private store: Store;
  private guard: RevenueGuardConfig;

  constructor(store: Store, guard: RevenueGuardConfig) {
    this.store = store;
    this.guard = guard;
  }

  async reserve(requestId: string, productId: string, maximumCost: number,
    identityKind: string, identityValue: string): Promise<BudgetDecision> {
    const allowed = await this.store.reserveCost(requestId, {
      productId, identityKind, identityValue, occurredAt: Date.now(),
      cost: maximumCost, cacheHit: false,
    }, {
      perRequest: this.guard.perRequestMaxCost, daily: this.guard.dailyMaxCost,
      monthly: this.guard.monthlyMaxCost,
      perProductDaily: this.guard.perProductDailyCost,
      perUserDaily: this.guard.perUserDailyCost,
    });
    return { allowed, reason: allowed ? "" : "atomic budget reservation refused" };
  }
  async finalize(requestId: string, actualCost: number): Promise<void> {
    await this.store.finalizeCost(requestId, actualCost);
  }
  async release(requestId: string): Promise<void> { await this.store.releaseCost(requestId); }

  async check(productId: string, estimatedCost: number, identity?: [string, string]): Promise<BudgetDecision> {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    if (estimatedCost > this.guard.perRequestMaxCost) {
      return { allowed: false, reason: `per-request cost ${estimatedCost.toFixed(4)} exceeds max ${this.guard.perRequestMaxCost.toFixed(4)}` };
    }

    const globalDaily = await this.store.sumCost(now - day);
    if (globalDaily + estimatedCost > this.guard.dailyMaxCost) {
      return { allowed: false, reason: `global daily budget exceeded (${globalDaily.toFixed(2)} + ${estimatedCost.toFixed(4)} > ${this.guard.dailyMaxCost.toFixed(2)})` };
    }

    const globalMonthly = await this.store.sumCost(now - 30 * day);
    if (globalMonthly + estimatedCost > this.guard.monthlyMaxCost) {
      return { allowed: false, reason: "global monthly budget exceeded" };
    }

    const productDaily = await this.store.sumCost(now - day, productId);
    if (productDaily + estimatedCost > this.guard.perProductDailyCost) {
      return { allowed: false, reason: `product '${productId}' daily budget exceeded` };
    }

    if (identity) {
      const userDaily = await this.store.sumCost(now - day, productId, identity);
      if (userDaily + estimatedCost > this.guard.perUserDailyCost) {
        return { allowed: false, reason: `user '${identity[1]}' daily budget exceeded` };
      }
    }

    return { allowed: true, reason: "" };
  }

  async record(
    productId: string, cost: number, identityKind: string, identityValue: string, cacheHit = false,
  ): Promise<void> {
    await this.store.recordUsage({
      productId, identityKind, identityValue, occurredAt: Date.now(), cost, cacheHit,
    });
  }
}
