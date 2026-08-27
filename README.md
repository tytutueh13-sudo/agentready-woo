# AgentReady Woo — agentic-commerce readiness toolkit for self-hosted WooCommerce stores

Live at **[app.utilityhouse.xyz](https://app.utilityhouse.xyz)**.

AgentReady scans a self-hosted WooCommerce store and scores how ready it is for
AI-agent commerce (MCP/A2A), then exposes the live catalog through a product
feed and an MCP tool surface that shopping agents can query and buy from.
Checkout always completes on the merchant's own site through a signed,
time-limited cart handoff — no card data ever passes through AgentReady.

Connect a store by pasting its URL and a read-only WooCommerce REST API key
generated in the merchant's own WordPress admin (Settings → Advanced → REST
API). No plugin install required. The key is revocable in one click and
AgentReady never writes to the store — read-only catalog access only.

## What it does

- **Free readiness scan** — grades any WooCommerce store out of 100: discovery
  files, Store API health, feed quality, cart-handoff support.
- **Live product feed** — re-synced from the store on a schedule; price and
  stock stay current.
- **Agent discovery file** — `/.well-known/agenticweb.md` per connected store,
  so agents can find what a store's feed supports before calling it.
- **MCP tool surface** — agents call `search_products`, `get_offer`,
  `get_feed`, `create_cart_link`, and `verify_cart_link` against a store's
  live catalog.
- **Signed cart handoff** — HMAC-signed, single-use add-to-cart links that
  expire in ≤60 minutes; the buyer completes checkout on the merchant's own
  site.
- **Dashboard** — agent traffic and missed-opportunity visibility for the
  merchant.

## MCP endpoints

This repo exposes two distinct MCP surfaces sharing one tool-call shape
(`POST {tool, input}` — MCP-*shaped*, not the full JSON-RPC 2.0 protocol; see
"Status" below):

- **Per-store commerce tool** — `POST /mcp/{store_id}` — the five catalog
  tools listed above, scoped to one connected merchant's live store.
- **Readiness-scan tool** — `POST /mcp` — a single global, x402
  payment-gated tool (`agentready_woo_agentic_commerce_readiness_toolkit_for_self_h`)
  that scores any WooCommerce store's agent-readiness on demand.

## Status

Deployed and in production use, with a real Paddle billing integration and a
D1-backed financial ledger for the x402-gated readiness-scan tool. Test
suite (`npm test`) covers auth, billing webhooks, the readiness scanner, and
the MCP tool surface.

The MCP tool-call shape is intentionally minimal — `{tool, input}` over
JSON — rather than the full JSON-RPC 2.0 MCP protocol. Wiring the official
`@modelcontextprotocol/sdk` framing is a tracked follow-up, not a blocker for
current use (see `mcp-registry/server.json` for the registry-facing
description).

## Local development

```bash
npm install
npm run typecheck
npm test
```

## Deployment

Cloudflare Workers, via `wrangler.toml` in this repo (D1 binding, custom
domain routing, secrets documented inline as comments — secrets themselves
are never committed, only set with `wrangler secret put`).

```bash
npx wrangler deploy
```

## License

Proprietary. Source is published here for MCP Registry / agent-discovery
transparency; this is not an open-source license grant.
