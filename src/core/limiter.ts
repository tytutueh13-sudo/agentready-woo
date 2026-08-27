// Rate limiting (section 18). Sliding-window request count per identity.
import type { RevenueGuardConfig } from "./pricing.ts";
import type { Store } from "./types.ts";

export interface RateLimitDecision {
  allowed: boolean;
  countInWindow: number;
  limit: number;
}

export class RateLimiter {
  private store: Store;
  private guard: RevenueGuardConfig;

  constructor(store: Store, guard: RevenueGuardConfig) {
    this.store = store;
    this.guard = guard;
  }

  async check(productId: string, identityKind: string, identityValue: string): Promise<RateLimitDecision> {
    const since = Date.now() - this.guard.rateLimitWindowSeconds * 1000;
    const count = await this.store.countRequests(productId, identityKind, identityValue, since);
    return { allowed: count < this.guard.rateLimitMaxRequests, countInWindow: count, limit: this.guard.rateLimitMaxRequests };
  }
}
