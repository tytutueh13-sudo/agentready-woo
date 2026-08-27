// Response cache (section 20). A cache failure must fail OPEN (fall through
// to the upstream call) — see RevenueGuard below — never take a request down.
import type { RevenueGuardConfig } from "./pricing.ts";
import type { Store } from "./types.ts";

async function cacheKey(productId: string, payload: Record<string, unknown>): Promise<string> {
  const basis = productId + "|" + JSON.stringify(payload, Object.keys(payload).sort());
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CacheResult {
  hit: boolean;
  value?: unknown;
}

export class ResponseCache {
  private store: Store;
  private guard: RevenueGuardConfig;

  constructor(store: Store, guard: RevenueGuardConfig) {
    this.store = store;
    this.guard = guard;
  }

  async get(productId: string, payload: Record<string, unknown>): Promise<CacheResult> {
    const key = await cacheKey(productId, payload);
    const row = await this.store.getCache(key);
    if (!row) return { hit: false };
    return { hit: true, value: row.response };
  }

  async set(productId: string, payload: Record<string, unknown>, response: unknown, ttlSeconds?: number): Promise<void> {
    const key = await cacheKey(productId, payload);
    const ttl = ttlSeconds ?? this.guard.cacheDefaultTtlSeconds;
    const expiresAt = ttl > 0 ? Date.now() + ttl * 1000 : null;
    await this.store.setCache(key, { response, createdAt: Date.now(), expiresAt });
  }
}
