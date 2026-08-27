// Margin Guard (section 15). Mirrors src/revenue/pricing.py exactly.

export interface RevenueGuardConfig {
  minGrossMarginRatio: number;
  minPriceMultiplier: number;
  perRequestMaxCost: number;
  dailyMaxCost: number;
  monthlyMaxCost: number;
  perUserDailyCost: number;
  perProductDailyCost: number;
  rateLimitWindowSeconds: number;
  rateLimitMaxRequests: number;
  circuitBreakerFailureThreshold: number;
  circuitBreakerWindowSeconds: number;
  circuitBreakerCooldownSeconds: number;
  cacheDefaultTtlSeconds: number;
}

export interface PriceCheck {
  price: number;
  estimatedCost: number;
  minRequiredPrice: number;
  passes: boolean;
  margin: number;
  marginRatio: number;
}

export function checkPrice(price: number, estimatedCost: number, guard: RevenueGuardConfig): PriceCheck {
  const byRatio = guard.minGrossMarginRatio < 1
    ? estimatedCost / (1 - guard.minGrossMarginRatio) : Infinity;
  const byMultiplier = estimatedCost * guard.minPriceMultiplier;
  const minRequired = estimatedCost > 0 ? Math.max(byRatio, byMultiplier) : 0;
  const margin = price - estimatedCost;
  return {
    price, estimatedCost, minRequiredPrice: minRequired,
    passes: estimatedCost <= 0 || price >= minRequired,
    margin, marginRatio: price > 0 ? margin / price : 0,
  };
}
