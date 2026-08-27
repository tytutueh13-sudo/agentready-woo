// Shared types for the Revenue Guard chain. Mirrors src/revenue + src/payments in the
// Python project — see README.md "Revenue Guard" section for the call order this supports.

export type PaymentStatus = "paid" | "unpaid" | "invalid" | "expired";

export interface PaymentVerification {
  status: PaymentStatus;
  amount: number;
  payer: string;
  reference: string;
}

export function isVerified(v: PaymentVerification): boolean {
  return v.status === "paid";
}

export type GuardStage =
  | "kill_switch" | "auth" | "payment" | "rate_limit" | "quota" | "estimate_cost"
  | "margin" | "budget" | "cache" | "upstream" | "result" | "usage_record";

export interface RequestContext {
  productId: string;
  identityKind: string;
  identityValue: string;
  authenticated: boolean;
  requestPayload: Record<string, unknown>;
  pricePerCall: number;
  estimatedCost: number;
  paymentReference?: string;
  upstreamName: string;
  upstream: (idempotencyKey: string) => Promise<unknown>;
  actualCost?: (result: unknown) => number;
  requestId?: string;
  artifactHash?: string;
  outputSchema?: Record<string, unknown>;
}

export interface GuardOutcome {
  allowed: boolean;
  stageReached: GuardStage;
  reason: string;
  result?: unknown;
  cacheHit: boolean;
  trace: GuardStage[];
  paymentRequirement?: PaymentRequirementPublic;
  paymentResponse?: PaymentResponsePublic;
}

export interface PaymentResponsePublic {
  success: boolean; transaction: string; network: string; payer: string; amount: string;
}

export interface PaymentRequirementPublic {
  scheme: "upto";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

// --- observability (section 46) ---------------------------------------------
// Every generated product must be ABLE to record these events; whether they
// go anywhere (console, an analytics binding, etc.) is a deployment-time
// choice — see eventSink.ts. Not wired to any external service in this phase.

export type GuardEventType =
  | "request_received" | "payment_verified" | "request_rejected" | "cache_hit"
  | "upstream_called" | "upstream_failed" | "result_returned" | "revenue_recorded"
  | "cost_recorded" | "circuit_opened" | "budget_exceeded";

export interface GuardEvent {
  type: GuardEventType;
  productId: string;
  stage?: GuardStage;
  data?: Record<string, unknown>;
  occurredAt: number;
}

export interface EventSink {
  emit(event: GuardEvent): void;
}

// --- storage abstraction ----------------------------------------------------
// One interface, two implementations: MemoryStore (used for local testing and
// as the default), KVStore (Cloudflare KV-backed, for the deployed Worker).
// Business logic below only ever depends on this interface, never on a
// specific backend — see section 24 of the project spec.

export interface UsageRow {
  productId: string;
  identityKind: string;
  identityValue: string;
  occurredAt: number; // epoch ms
  cost: number;
  cacheHit: boolean;
}

export interface CacheRow {
  response: unknown;
  createdAt: number;
  expiresAt: number | null;
}

export interface CircuitRow {
  state: "closed" | "open" | "half_open";
  failureCount: number;
  openedAt: number | null;
  updatedAt: number;
}

export type FinancialOperationState =
  | "CREATED" | "COST_RESERVED" | "PAYMENT_AUTHORIZED" | "UPSTREAM_STARTED"
  | "RESULT_ESCROWED" | "SETTLEMENT_PENDING" | "SETTLEMENT_AMBIGUOUS"
  | "SETTLED" | "RESULT_RELEASED" | "RECOVERY_REQUIRED" | "FAILED_FINAL";

export interface FinancialOperation {
  operationId: string; requestId: string; requirementId: string; productId: string;
  requestHash: string; artifactHash: string; paymentProvider: string;
  paymentReference: string; requirementJson: string; payer: string;
  reservationId: string; upstreamOperationId: string; settlementId: string;
  state: FinancialOperationState; authorizedAmount: number; reservedAmount: number;
  actualCost: number | null; settlementAmount: number | null; resultDigest: string;
  errorCode: string; version: number; recoveryOwner: string; recoveryLeaseUntil: number;
  createdAt: number; updatedAt: number;
}

export interface ResultEscrowRow {
  operationId: string; resultDigest: string; payloadJson: string;
  payloadSize: number; createdAt: number; expiresAt: number; releasedAt: number | null;
}

export type SettlementOutboxStatus = "PENDING" | "AMBIGUOUS" | "SETTLED" | "FINAL_FAILURE";
export interface SettlementOutboxRow {
  settlementId: string; operationId: string; paymentProvider: string; amount: number;
  status: SettlementOutboxStatus; attemptCount: number; lastAttemptAt: number | null;
  providerReference: string; lastErrorCode: string; createdAt: number; updatedAt: number;
}

export interface Store {
  recordUsage(row: UsageRow): Promise<void>;
  sumCost(sinceMs: number, productId?: string, identity?: [string, string]): Promise<number>;
  countRequests(productId: string, identityKind: string, identityValue: string, sinceMs: number): Promise<number>;
  getCache(key: string): Promise<CacheRow | null>;
  setCache(key: string, row: CacheRow): Promise<void>;
  getCircuit(upstream: string): Promise<CircuitRow | null>;
  setCircuit(upstream: string, row: CircuitRow): Promise<void>;
  reserveCost(requestId: string, row: UsageRow, limits: {
    perRequest: number; daily: number; monthly: number;
    perProductDaily: number; perUserDaily: number;
  }): Promise<boolean>;
  finalizeCost(requestId: string, actualCost: number): Promise<void>;
  releaseCost(requestId: string): Promise<void>;
  createOperation(row: FinancialOperation): Promise<boolean>;
  getOperation(operationId: string): Promise<FinancialOperation | null>;
  transitionOperation(operationId: string, expectedVersion: number,
    expectedStates: FinancialOperationState[], nextState: FinancialOperationState,
    patch?: Partial<FinancialOperation>): Promise<boolean>;
  saveEscrow(row: ResultEscrowRow): Promise<boolean>;
  getEscrow(operationId: string): Promise<ResultEscrowRow | null>;
  markEscrowReleased(operationId: string, releasedAt: number): Promise<void>;
  createSettlementOutbox(row: SettlementOutboxRow): Promise<boolean>;
  getSettlementOutbox(settlementId: string): Promise<SettlementOutboxRow | null>;
  updateSettlementOutbox(settlementId: string, status: SettlementOutboxStatus,
    errorCode?: string, providerReference?: string): Promise<void>;
  claimRecovery(operationId: string, owner: string, now: number, leaseUntil: number): Promise<boolean>;
  releaseRecovery(operationId: string, owner: string): Promise<void>;
  recordFinancialIncident(operationId: string, kind: string, detail: string): Promise<void>;
  isProductHalted(productId: string): Promise<boolean>;
  // H-02: on the interface so a store that cannot enforce the ledger halt is a
  // type error rather than a silently missing runtime call.
  reconcileOperation(operationId: string): Promise<{ ok: boolean; detail: string }>;
  listOperationsForReconciliation(limit: number): Promise<FinancialOperation[]>;
  listRecoverableOperations(limit: number): Promise<FinancialOperation[]>;
  recoverExpiredSafeReservations(cutoff: number): Promise<number>;
  savePaymentProof(operationId: string, payloadJson: string, expiresAt: number): Promise<boolean>;
  getPaymentProof(operationId: string): Promise<string | null>;
  deletePaymentProof(operationId: string): Promise<void>;
  purgeExpiredSensitiveData(now: number): Promise<number>;
}
