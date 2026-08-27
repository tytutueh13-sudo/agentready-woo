// Circuit breaker (section 19). closed -> open (N failures in a window) ->
// half_open (after cooldown) -> closed on success / open again on failure.
import type { RevenueGuardConfig } from "./pricing.ts";
import type { CircuitRow, Store } from "./types.ts";

export interface CircuitDecision {
  allowed: boolean;
  state: CircuitRow["state"];
  reason: string;
}

export class CircuitBreaker {
  private store: Store;
  private guard: RevenueGuardConfig;

  constructor(store: Store, guard: RevenueGuardConfig) {
    this.store = store;
    this.guard = guard;
  }

  async check(upstream: string): Promise<CircuitDecision> {
    const row = await this.store.getCircuit(upstream);
    if (!row) return { allowed: true, state: "closed", reason: "" };

    if (row.state === "closed") return { allowed: true, state: "closed", reason: "" };

    if (row.state === "open") {
      if (row.openedAt !== null) {
        const elapsedSeconds = (Date.now() - row.openedAt) / 1000;
        if (elapsedSeconds >= this.guard.circuitBreakerCooldownSeconds) {
          await this.store.setCircuit(upstream, { ...row, state: "half_open", updatedAt: Date.now() });
          return { allowed: true, state: "half_open", reason: "cooldown elapsed, probing" };
        }
      }
      return { allowed: false, state: "open", reason: "circuit open" };
    }

    return { allowed: true, state: "half_open", reason: "half-open probe in progress" };
  }

  async recordSuccess(upstream: string): Promise<void> {
    const row = await this.store.getCircuit(upstream);
    if (!row || row.state !== "closed" || row.failureCount !== 0) {
      await this.store.setCircuit(upstream, { state: "closed", failureCount: 0, openedAt: null, updatedAt: Date.now() });
    }
  }

  async recordFailure(upstream: string): Promise<void> {
    const now = Date.now();
    const row = await this.store.getCircuit(upstream);
    let failureCount: number;
    let state: CircuitRow["state"];
    if (!row) {
      failureCount = 1;
      state = "closed";
    } else {
      state = row.state;
      const withinWindow = (now - row.updatedAt) / 1000 <= this.guard.circuitBreakerWindowSeconds;
      failureCount = withinWindow ? row.failureCount + 1 : 1;
    }

    if (state === "half_open") {
      await this.store.setCircuit(upstream, { state: "open", failureCount, openedAt: now, updatedAt: now });
      return;
    }
    if (failureCount >= this.guard.circuitBreakerFailureThreshold) {
      await this.store.setCircuit(upstream, { state: "open", failureCount, openedAt: now, updatedAt: now });
    } else {
      await this.store.setCircuit(upstream, { state: "closed", failureCount, openedAt: null, updatedAt: now });
    }
  }
}
