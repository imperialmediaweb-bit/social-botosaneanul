import { extractTag } from "./entities.js";

// Fetch + parse simplu de RSS (WordPress). Nu depindem de un parser XML:
// feed-urile WP sunt suficient de regulate, iar extractTag gestionează CDATA.
export async function fetchFeedItems(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/rss+xml, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Feed fetch failed (${res.status}) for ${feedUrl}`);
  const xml = await res.text();

  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[0];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const description = extractTag(block, "description");
    const contentEncoded = extractTag(block, "content:encoded");
    if (!title || !/^https?:\/\//i.test(link)) continue;
    items.push({ title, link, description, contentEncoded });
  }
  return items;
}
