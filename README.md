# AgentReady Woo — agentic-commerce readiness for self-hosted WooCommerce

Live at **[app.utilityhouse.xyz](https://app.utilityhouse.xyz)**.

AgentReady reads a public WooCommerce storefront the way a shopping agent would
and reports what it found. It reads public pages and the public WooCommerce
Store API. It changes nothing, stores no customer data, and returns no product
text.

**When it cannot read a store, it says so.** A shop that is down, blocked or not
yet public comes back as `state: UNREADABLE` with `score: null` — an abstention,
not a low grade. That distinction is the point of the product: a number derived
from our own failed requests is a number a merchant would act on.

Diagnostic accuracy against real merchant stores is **unmeasured** and is
claimed nowhere. This is not a certification, a visibility guarantee, or a
checkout test.

## The five tools

`POST /mcp` speaks **JSON-RPC 2.0**. `tools/list` returns five tools.

Two need no credentials at all:

| Tool | What it answers |
| --- | --- |
| `scan_woo_store_readiness` | Is this public storefront readable by shopping agents? |
| `preflight_woo_store` | The same question for one origin, passive and read-only. |

Three require the merchant's own verified ownership and are unreachable
without it:

| Tool | What it does |
| --- | --- |
| `start_woo_release_verification` | Starts a release run against pinned protocol evidence. |
| `get_woo_release_verification` | Reads that run's state. |
| `claim_woo_release_result` | Claims the result packet once, idempotently. |

There is also `POST /api/v2/preflight`, documented in
`mcp-registry/openapi-preflight.yaml` as an OpenAPI 3.1 document. A `200` from
it does **not** mean the store could be read — check `state` before using
`checks`.

## Rate limits, as they are

Three calls per target origin per day, and ten per calling IP per day.
Exceeding either returns `429` with `TARGET_RATE_LIMITED`. These are the real
numbers, not a friendlier pair.

## Settlement

**Settlement is disabled.** No route on this service can take money. Prices
appear on the marketing page as prices for a thing that is not yet purchasable,
and every place one is shown says so. The Paddle integration and the D1
financial ledger exist and are exercised by the test suite; the flag that would
let them move money is deliberately absent, and the x402 configuration points
at Base **Sepolia** testnet.

## The WordPress plugin

`wordpress-plugin/agentready-woo` publishes `/.well-known/agenticweb.md` and,
when a merchant connects it, sends one signed **aggregate** evidence envelope —
a count and a check result, never a product, shopper, order, payment, address or
credential. It is verified against real WordPress and WooCommerce with HPOS both
on and off; see `wordpress-plugin/agentready-woo/INTEGRATION-HARNESS.md`.

## Local development

```bash
npm install
npm run typecheck
npm test
npm run dev:worker
```

`npm test` uses Node's own test runner. There is no build step: the Worker runs
TypeScript directly under Node 25 type-stripping, which is why parameter
properties do not appear anywhere in `src/`.

## What this repository is not

It is a public mirror of one service from a private monorepo. It is not the
deployment source, and `wrangler.toml` here carries a placeholder database id
rather than the real one. Deploys are performed from the private repository by
one operator; nothing in this repository deploys anything.
