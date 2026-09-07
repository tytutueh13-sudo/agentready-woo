# WooCommerce Release Preflight — batch triage for agencies

Give it a list of public WooCommerce storefronts. Get one structured row per
origin, with **ready**, **needs work** and **could not tell** kept apart.

It reads public surfaces only. No credentials, no store changes, no ownership,
no plugin.

## The job this removes

You are quoting remediation work across a portfolio — your own clients, or a
prospect's twenty storefronts. Opening each one by hand to find the three that
are actually broken is an afternoon, and the answer is stale by the time you
have written the proposal.

## What a row says

| Outcome | Meaning | Charged |
| --- | --- | --- |
| `USEFUL` | the preflight read the store and returned checks | yes, once per distinct origin |
| `ABSTAINED` | it reached the store and could not tell — `BLOCKED`, `UNMEASURED`, `UNMEASURED_SOURCE` | **no** |
| `UPSTREAM_FAILED` | timeout, rate limit, or a non-200 from the service | **no** |
| `INVALID_INPUT` | the origin was refused before any request was made | **no** |

**An HTTP 200 is not a result.** The preflight answers 200 with
`state: "BLOCKED"` for a target it could not read, and that row is an
abstention. The third column exists because a triage tool that hides its
unknowns is worse than no tool: you would quote on it.

The `state`, the per-check reason codes and the `unknowns` come back exactly as
the service produced them. This Actor scores nothing of its own.

## What it refuses, before spending a request

Plaintext `http://`, credentials in the URL, a path or query string instead of
an origin, `localhost` and the private ranges, and anything that is not a
public hostname. The service has its own guard; this is a cheap first pass so a
bad row does not consume a quota.

## What it does not do

**It does not run the Release Gate.** The Gate is ownership-authorized: it needs
a bearer token, a verified ownership record and signed evidence from the
store's own WordPress plugin. A batch of public origins has none of those, so
every row would come back `AUTH_REQUIRED`. The Gate is a different product for a
different person — the merchant shipping their own release — and it is
deliberately out of this Actor's scope.

It is also not a certification, not a visibility guarantee, and not a checkout
test. It makes no claim about diagnostic accuracy: that is unmeasured.

## Limits, and why they are small

`concurrency` defaults to 2 and caps at 4.

Without a channel credential this Actor is an ordinary public caller: **10
preflight calls per day per address**, shared with every other Actor on the
platform. That is the wall a batch product hits.

With the credential (`AGENTREADY_PREFLIGHT_CHANNEL_TOKEN`, injected from Apify's
secret store) the server replaces the per-address limit with a distributed daily
budget it keeps for this channel. The credential alone is not enough: the budget
starts at zero and is configured deliberately.

**The per-target-origin limit is unchanged at 3/day either way.** It protects
the merchant's store rather than our capacity, so authentication does not buy
more of it. Asking about the same store four times in a day returns
`TARGET_RATE_LIMITED` on the fourth, as it should.

Retries are safe: each run carries its Apify run id and each origin its own item
key, so a resurrected run is answered from the first attempt rather than asked
again — and is never billed twice.

Batch caps at 100 origins; 25 is the comfortable size. Duplicates are asked
once. Requests time out at 45 s and responses over 512 KB are dropped.

## Pricing

Pay Per Event is **defined and not activated**. `CHARGED_EVENT` is
`preflight-answered`, one per distinct origin that actually returned an answer.
A free run logs what would have been charged and charges nothing. Settlement for
this product is disabled; activation is the owner's decision, not a code change.

## Where the logic lives

`batch.ts` holds every decision and has no SDK in it, so it is tested in the
service's own suite (`tests/apifyBatchPreflight.test.ts`, 13 tests). `main.ts`
only wires Apify: read input, run, push rows, count. The canonical service is
`POST https://app.utilityhouse.xyz/api/v2/preflight`.

## Example

Input:

```json
{
  "store_origins": [
    "https://northwindwool.example",
    "https://harborlight-supply.example",
    "http://not-secure.example"
  ],
  "requested_families": ["woo", "robots", "jsonld"]
}
```

Rows (fictional stores, real shapes):

```json
{"store_origin":"https://northwindwool.example","outcome":"USEFUL","state":"READY","reason":null,"checks_passed":7,"checks_total":9,"unknowns":[],"observed_at":"2026-09-07T06:20:31.073Z","billable":true}
{"store_origin":"https://harborlight-supply.example","outcome":"ABSTAINED","state":"BLOCKED","reason":"TARGET_PRIVATE","checks_passed":0,"checks_total":1,"unknowns":["TARGET_PRIVATE"],"observed_at":"2026-09-07T06:20:33.512Z","billable":false}
{"store_origin":"http://not-secure.example","outcome":"INVALID_INPUT","state":null,"reason":"ORIGIN_NOT_HTTPS","checks_passed":0,"checks_total":0,"unknowns":[],"observed_at":null,"billable":false}
```

Two of the three needed a human. That is the output this exists to produce.
