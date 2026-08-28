// IndexNow: a real-time "this URL changed" push to Bing/Yandex/etc, in place
// of waiting for a scheduled re-crawl. No account or OAuth — ownership is
// proven by hosting the key at keyLocation, which is just a static asset
// (marketing/landing/{key}.txt) served alongside the rest of the site.
const INDEXNOW_KEY = "9766c1c1d489ac67ef3c243389719fe5";
const INDEXNOW_HOST = "app.utilityhouse.xyz";

function extractSitemapUrls(sitemapXml: string): string[] {
  const matches = sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g);
  return [...matches].map(m => m[1]);
}

/** Submits every URL currently in the live sitemap. Safe to call repeatedly
 * — IndexNow is a "here's the current state" push, not a diff, so re-
 * submitting unchanged URLs is a no-op on Bing's side, not a duplicate. */
export async function pingIndexNow(baseUrl: string): Promise<void> {
  const sitemapRes = await fetch(`${baseUrl}/sitemap.xml`);
  if (!sitemapRes.ok) return;
  const urlList = extractSitemapUrls(await sitemapRes.text());
  if (!urlList.length) return;
  await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: INDEXNOW_HOST,
      key: INDEXNOW_KEY,
      keyLocation: `${baseUrl}/${INDEXNOW_KEY}.txt`,
      urlList,
    }),
  });
}
