# What Codex must configure, and what is no longer a blocker

Updated 2026-09-07. **B1 is closed in code.** The rest are account actions.

## B1 — the shared-IP bottleneck (closed, needs configuration)

**The problem.** `POST /api/v2/preflight` counted twice: 3/day per target
origin and 10/day per calling IP. An Actor shares Apify's IP pool, so the tenth
request in a day was refused to a caller who had made one, and a twenty-store
triage — the product's whole reason to exist — could not complete.

**What was not done.** No User-Agent trust, no IP allowlist, no query-string
secret, no hidden unlimited route. Every one of those is tested for and fails.

**What was built.** An authenticated server-to-server channel that replaces
*only* the per-IP limit:

| Property | Behaviour |
| --- | --- |
| Identification | `Authorization: Bearer <secret>`, compared in constant time |
| No secret configured | there is no channel; every caller gets the public limits |
| Wrong or malformed token | ordinary public caller, and no channel budget is spent |
| Per-target-origin limit | **unchanged at 3/day** — it protects merchants' stores, not our capacity |
| Per-IP limit | replaced, for the channel only, by a distributed daily budget |
| Budget storage | D1 tables `channel_budget_config` / `channel_budget_daily`, never an isolate-local `Map` |
| Default budget | **zero** — deploying the code does not switch the channel on |
| Idempotency | `x-agentready-run` + `x-agentready-item`; a replay returns the first outcome, spends no budget, and is never billable a second time |
| Ledger contents | channel id, day, count, outcome. No origin, token, body or result. |
| Refusals | `429` with `TARGET_RATE_LIMITED` and a `Retry-After` to the next UTC day |

Schema version moved 12 → 13 (`app_channel_budget_v13_apify_seam`). The file's
own warning applies: the version and the table list are checksummed together,
so both moved.

### What Codex applies later — names only, never values

| Where | Name | Note |
| --- | --- | --- |
| Cloudflare secret | `PREFLIGHT_CHANNEL_TOKEN` | `wrangler secret put` — **do not** put it in `wrangler.toml` |
| Apify secret / env | `AGENTREADY_PREFLIGHT_CHANNEL_TOKEN` | the same value, injected into the Actor |
| D1 row | `channel_budget_config` | `INSERT INTO channel_budget_config(channel_id,daily_cap,updated_at) VALUES('apify-batch-preflight', <cap>, unixepoch()*1000)` |

**No value has been created, generated, printed or committed.** Until the D1 row
exists the channel answers `429`, which is the intended state.

Suggested first cap: small — a few hundred a day — and raised on evidence. The
Actor's own defaults (25 origins, concurrency 2) stay well inside that.

## B2 — Apify account, Store approval, KYC

Not started. Owner. Agentic-payment eligibility needs KYC, limited permissions,
Pay Per Event, event-only charging and no Standby; none of it is claimed in the
listing.

## B3 — paid activation

`PAID_ACTIVATION` is `false` in `main.ts` and the product's settlement is
disabled. Owner decision, recorded in the launch record, not an edit.

## B4 — the Actor name is not reserved

`woocommerce-release-preflight-batch` has not been checked for collision on the
Store. Check before first publish; renaming after publication changes the URL.

## B5 — deployment order

The channel is candidate code. Until Codex deploys it, production still has the
old per-IP behaviour, and the Actor will hit the ten-per-day wall. **Deploy
first, configure the budget, then publish the Actor** — not the other way round.
