// wrangler.toml serves marketing/landing as the site's public assets, so every
// file in it is uploaded and reachable by URL whether or not a page links to
// it. Removing a <video src> is therefore not the same as unpublishing a file —
// which is how 2MB of unlicensed stock footage stayed publicly served after it
// was taken off the page.
//
// Also here: the hosts, the video's fallbacks, and the claim that the demo is
// silent, all checked against the bytes rather than the intention.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LANDING = join(ROOT, "marketing/landing");
const text = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every page that could reference an asset, concatenated. */
function allMarkup(): string {
  return readdirSync(LANDING)
    .filter(f => /\.(html|css|txt|xml|json)$/.test(f))
    .map(f => readFileSync(join(LANDING, f), "utf8")).join("\n")
    + text("src/web.ts") + text("wrangler.toml");
}

test("no file is published that nothing references", () => {
  // Files a browser or crawler fetches by convention rather than by link.
  const byConvention = new Set([
    "_headers", "robots.txt", "sitemap.xml", "llms.txt", "favicon.ico",
    "favicon.svg", "apple-touch-icon.png", "index.html",
  ]);
  const markup = allMarkup();
  const orphans = readdirSync(LANDING).filter(name => {
    if (byConvention.has(name)) return false;
    if (statSync(join(LANDING, name)).isDirectory()) return false;
    if (/^[0-9a-f]{32}\.txt$/.test(name)) return false;   // IndexNow key file
    // Cloudflare Assets serves support.html at /support, so an .html file may
    // be linked by its extensionless path and never by its filename.
    const extensionless = name.replace(/\.html$/, "");
    return !markup.includes(name) && !markup.includes(`"/${extensionless}"`);
  });
  assert.deepEqual(orphans, [], `served but unreferenced: ${orphans.join(", ")}`);
});

/** The public mirror ships marketing/landing but not the internal directories,
 * so a test that reads one must say so rather than fail there. It skips only
 * when the whole directory is absent; a missing file inside a present
 * directory is still a failure. */
function onlyInMonorepo(dir: string): boolean {
  try { statSync(join(ROOT, dir)); return false; } catch { return true; }
}

test("the stock footage is out of the upload path, not merely off the page", (t) => {
  if (onlyInMonorepo("marketing/unlicensed-hold")) return t.skip("public mirror: held files are withheld");
  for (const gone of ["hero-ad.mp4", "hero-poster.jpg"]) {
    assert.equal(readdirSync(LANDING).includes(gone), false,
      `${gone} is still in the assets directory and would still be served`);
  }
  assert.ok(statSync(join(ROOT, "marketing/unlicensed-hold", "hero-ad.mp4")).size > 0,
    "it is held, not deleted — the licence question is the owner's, not ours");
});

test("the demo video has both encodings, a poster, and every fallback", () => {
  const page = text("marketing/landing/index.html");
  assert.match(page, /<source src="demo-preflight\.webm" type="video\/webm">/);
  assert.match(page, /<source src="demo-preflight\.mp4" type="video\/mp4">/);
  assert.match(page, /poster="demo-preflight-poster\.jpg"/);
  // load failure: the poster is painted on the hero itself, so a video that
  // never loads still shows the still, and a still that never loads shows ground
  assert.match(page, /\.hero\{background:#141218 url\(demo-preflight-poster\.jpg\)/);
  // reduced motion: the film stops but the frame remains
  const rm = page.slice(page.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(rm.slice(0, 260), /\.hero video\{display:none\}/);
  assert.match(rm.slice(0, 260), /demo-preflight-poster\.jpg/,
    "reduced motion should stop the film, not blank the hero");
  assert.match(page, /aria-label="A silent recording/);
});

test("neither demo file contains an audio track", () => {
  // An autoplaying page video that has audio is one browser policy change away
  // from making noise at a stranger. Checked in the container: an MP4 with
  // sound carries an 'soun' handler box; a WebM carries an Audio track entry.
  const mp4 = readFileSync(join(LANDING, "demo-preflight.mp4"));
  assert.equal(mp4.includes(Buffer.from("soun", "ascii")), false,
    "demo-preflight.mp4 has a sound handler");
  const webm = readFileSync(join(LANDING, "demo-preflight.webm"));
  assert.equal(webm.includes(Buffer.from("A_OPUS", "ascii"))
            || webm.includes(Buffer.from("A_VORBIS", "ascii")), false,
    "demo-preflight.webm has an audio codec");
});

test("the four stories each ship a light and a dark card", (t) => {
  if (onlyInMonorepo("registration-handoff")) return t.skip("public mirror: the marketplace kit is withheld");
  const dir = join(ROOT, "registration-handoff/marketplace-kit/assets/social");
  const files = readdirSync(dir);
  for (const story of ["a-receipt", "b-triage", "c-contract", "d-transform"]) {
    for (const theme of ["light", "dark"]) {
      const name = `card-${story}-${theme}.png`;
      assert.ok(files.includes(name), `missing ${name}`);
      assert.ok(statSync(join(dir, name)).size > 4096, `${name} is too small to be a card`);
    }
  }
});

test("the host that has no DNS record appears nowhere", () => {
  // agentready.utilityhouse.xyz does not resolve. It was in the plugin header
  // wordpress.org checks, the plugin's own scan link, readme install steps, and
  // the outbound User-Agent a merchant reads in their access log.
  for (const file of ["marketing/landing/index.html", "src/core/acpQuote.ts",
                      "wordpress-plugin/agentready-woo/agentready-woo.php",
                      "wordpress-plugin/agentready-woo/readme.txt",
                      "wordpress-plugin/agentready-woo/includes/class-agentready-woo.php"]) {
    assert.equal(text(file).includes("agentready.utilityhouse.xyz"), false,
      `${file} points at a host with no DNS record`);
  }
});

test("the social cards and the pages name the same canonical origin", () => {
  const page = text("marketing/landing/index.html");
  for (const tag of [/rel="canonical" href="https:\/\/app\.utilityhouse\.xyz\//,
                     /og:url" content="https:\/\/app\.utilityhouse\.xyz\//,
                     /og:image" content="https:\/\/app\.utilityhouse\.xyz\//]) {
    assert.match(page, tag);
  }
});

test("the OG image is the generated landing card, byte for byte", (t) => {
  if (onlyInMonorepo("registration-handoff")) return t.skip("public mirror: the marketplace kit is withheld");
  // The shipped one told a story the product had outgrown — "Your store isn't
  // invited", "buyable" on a service that cannot settle, and a sign-off on
  // agentready.utilityhouse.xyz, which has no DNS record. It is now a render of
  // the page's own headline, and this pins the copy step: edit the card without
  // copying it, or edit the OG directly, and this fails.
  const og = readFileSync(join(LANDING, "og-image.png"));
  const card = readFileSync(join(ROOT,
    "registration-handoff/marketplace-kit/assets/social/card-landing-dark.png"));
  assert.equal(Buffer.compare(og, card), 0,
    "og-image.png has drifted from the card that generates it");
});

test("the retired OG story cannot come back through the meta tags", () => {
  const page = text("marketing/landing/index.html");
  for (const retired of [/isn'?t invited/i, /agentready\.utilityhouse\.xyz/]) {
    assert.equal(retired.test(page), false, `the old story returned: ${retired}`);
  }
  // "buyable" is deliberately NOT on that list. Settlement being disabled means
  // this service cannot take money; it does not mean a connected store cannot
  // be bought from. create_cart_link / verify_cart_link on the per-store
  // surface (src/service.ts) issue a signed, expiring link and the buyer
  // completes checkout on the merchant's own site. Checked before removing it.
  assert.match(text("src/service.ts"), /create_cart_link/,
    "if the cart handoff goes, the page may no longer say buyable");
});

test("nothing in the marketing page claims a purchase the service can make", () => {
  const page = text("marketing/landing/index.html");
  // A price may appear — the plans are real — but never without saying that
  // settlement is off, and never attached to the free preflight.
  const prices = [...page.matchAll(/\$\d[\d,.]*/g)];
  assert.ok(prices.length > 0, "the pricing section moved; re-point this test");
  assert.match(page, /settlement (remains )?disabled|not available for purchase/i,
    "a page showing a price on a service that cannot settle must say so");
});
