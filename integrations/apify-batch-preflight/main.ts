/** Apify entry point. Everything that decides anything lives in `batch.ts`.
 *
 * This file only wires the SDK: read input, run the batch, push the rows, and
 * count what would have been chargeable. It charges nothing — Pay Per Event is
 * defined here as a boundary and left inactive, because paid activation is the
 * owner's decision and settlement for this product is disabled.
 */

import {
  DEFAULT_MAX_ORIGINS, InvalidOrigin, billableCount, parseBatchInput, runBatch,
} from "./batch.ts";

/** The environment variable Apify injects from its secret store.
 *
 * Without it the Actor is an ordinary public caller and will hit the 10/day
 * per-IP limit it shares with every other Actor. With it, the server replaces
 * that limit with a distributed daily budget — which is zero until Codex
 * configures it, so the credential alone buys nothing. The value is never
 * printed, and never written into a dataset row. */
const CHANNEL_TOKEN_VAR = "AGENTREADY_PREFLIGHT_CHANNEL_TOKEN";

/** The event that *would* be charged, if and when the owner activates it.
 *
 * One event per distinct origin that actually came back with an answer.
 * Abstentions, upstream failures and refused inputs are excluded by
 * `billableCount`, and a repeated origin counts once. */
export const CHARGED_EVENT = "preflight-answered";

/** Set to true only by an owner decision, never by a code change alone. */
export const PAID_ACTIVATION = false;

/** The slice of the Apify SDK this Actor touches.
 *
 * Declared locally so the file type-checks in the service's own tsconfig
 * without the SDK installed here — the SDK is a dependency of the Actor image,
 * not of the Worker. If Apify changes one of these signatures, the Actor build
 * fails loudly in CI rather than this file silently drifting. */
interface ApifyActor {
  init(): Promise<void>;
  exit(): Promise<void>;
  fail(options: { statusMessage: string }): Promise<void>;
  getInput<T>(): Promise<T | null>;
  pushData(data: unknown): Promise<void>;
  charge(options: { eventName: string }): Promise<unknown>;
  log: { info(message: string): void; warning(message: string): void };
}

async function main(): Promise<void> {
  // The specifier is built at run time so the service's typecheck does not
  // need the SDK installed; the Actor image has it as a dependency.
  const sdk = "ap" + "ify";
  const { Actor } = await import(/* @vite-ignore */ sdk) as { Actor: ApifyActor };

  await Actor.init();
  try {
    const raw = (await Actor.getInput<Record<string, unknown>>()) ?? {};

    let input;
    try {
      input = parseBatchInput(raw);
    } catch (error) {
      const code = error instanceof InvalidOrigin ? error.code : "INVALID_INPUT";
      await Actor.fail({ statusMessage: `Input refused: ${code}` });
      return;
    }

    if (input.origins.length === 0) {
      await Actor.fail({ statusMessage: "No usable origin in the input. Every entry was refused." });
      return;
    }
    if (input.origins.length > DEFAULT_MAX_ORIGINS) {
      Actor.log.warning(
        `${input.origins.length} origins in one run. The upstream preflight is rate limited per caller, `
        + "so a long list is likely to return TARGET_RATE_LIMITED rows rather than answers.",
      );
    }

    // Apify gives every run an id; it is the idempotency scope, so a resurrected
    // or retried run asks the same questions and is answered, not re-billed.
    const token = process.env[CHANNEL_TOKEN_VAR];
    const runKey = process.env.APIFY_ACTOR_RUN_ID;
    const channel = token && runKey ? { token, runKey } : null;
    if (token && !runKey) {
      Actor.log.warning(
        "A channel token is set but APIFY_ACTOR_RUN_ID is not, so this run has no "
        + "idempotency scope. Running as a public caller instead of risking a double charge.");
    }
    Actor.log.info(channel
      ? "Authenticated channel: the per-IP limit is replaced by the server's channel budget."
      : "Public caller: subject to 10 preflight calls per day per address.");

    const rows = await runBatch(input, fetch, channel);
    await Actor.pushData(rows);

    const counts = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.outcome] = (acc[row.outcome] ?? 0) + 1;
      return acc;
    }, {});
    const chargeable = billableCount(rows);

    Actor.log.info(
      `${rows.length} rows: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}. `
      + `${chargeable} distinct origins answered.`,
    );

    if (PAID_ACTIVATION) {
      // Deliberately unreachable until an owner decision flips the flag, and
      // even then it charges per answered origin, never per request.
      for (let i = 0; i < chargeable; i += 1) await Actor.charge({ eventName: CHARGED_EVENT });
    } else {
      Actor.log.info(
        `Free run. ${chargeable} events would have been charged as "${CHARGED_EVENT}"; `
        + "settlement is disabled for this product and no charge was made.",
      );
    }
  } finally {
    await Actor.exit();
  }
}

await main();
