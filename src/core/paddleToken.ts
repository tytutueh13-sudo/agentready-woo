// Guard between Paddle's two credential types, which look similar and are
// pasted into the same kind of place.
//
// Paddle issues *client-side tokens* for Paddle.js (publishable — they ship
// in page HTML to every visitor) and *API keys* for server calls (secret,
// and ours carried All read / All write). On 2026-09-01 the server API key
// was set as PADDLE_CLIENT_TOKEN on the sibling Grant Fit worker and served
// publicly until it was revoked. Nothing used it in that window. This
// service shares the Paddle account and the same paste, so it carries the
// same guard — any non-empty string used to be accepted here too.
//
// So this is a DENYLIST, not an allowlist: it rejects only the shapes Paddle
// uses for secret keys. An allowlist of client-token prefixes would risk
// fail-closing on a perfectly good token and silently killing checkout,
// which is the more expensive mistake of the two.
const SERVER_KEY_MARKERS = ["apikey", "pdl_"];

/** False when the value looks like a Paddle *secret* API key rather than a
 * publishable client-side token. Empty input is false too — callers treat
 * both as "checkout not configured" and render a disabled button. */
export function isPublishableClientToken(value: string | undefined | null): value is string {
  const v = value?.trim().toLowerCase() ?? "";
  if (!v) return false;
  return !SERVER_KEY_MARKERS.some(marker => v.includes(marker));
}
