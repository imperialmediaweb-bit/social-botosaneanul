import { extractTag, decodeEntities } from "./entities.js";

// Fetch + parse de feed. Suportă ambele formate întâlnite:
//  - RSS 2.0 (martor): <item> cu <link>text</link>, <description>,
//    <content:encoded> și poza în <media:content url="...">
//  - Atom (botoșăneanul): <entry> cu <link rel="alternate" href="..."/>,
//    rezumat în <summary type="html"> și FĂRĂ nicio poză în feed
// Nu depindem de un parser XML: feed-urile sunt suficient de regulate,
// iar extractTag gestionează CDATA.
export async function fetchFeedItems(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Feed fetch failed (${res.status}) for ${feedUrl}`);
  const xml = await res.text();
  return parseFeed(xml);
}

export function parseFeed(xml) {
  const items = [];

  // RSS 2.0: <item>
  let m;
  const reItem = /<item[\s>][\s\S]*?<\/item>/gi;
  while ((m = reItem.exec(xml)) !== null) {
    const block = m[0];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const description = extractTag(block, "description");
    const contentEncoded = extractTag(block, "content:encoded");
    // poza principală: <media:content url="..."> (la WP featured image e des
    // DOAR aici, nu și în content:encoded)
    const media = /<media:content[^>]+url=["']([^"']+)["']/i.exec(block);
    const mediaUrl = media ? decodeEntities(media[1]) : "";
    if (!title || !/^https?:\/\//i.test(link)) continue;
    items.push({ title, link, description, contentEncoded, mediaUrl });
  }
  if (items.length > 0) return items;

  // Atom: <entry>
  const reEntry = /<entry[\s>][\s\S]*?<\/entry>/gi;
  while ((m = reEntry.exec(xml)) !== null) {
    const block = m[0];
    const title = extractTag(block, "title");
    const linkM =
      /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(block) ||
      /<link[^>]*href=["']([^"']+)["']/i.exec(block);
    const link = linkM ? decodeEntities(linkM[1]) : "";
    const summary = extractTag(block, "summary") || extractTag(block, "content");
    if (!title || !/^https?:\/\//i.test(link)) continue;
    items.push({ title, link, description: summary, contentEncoded: summary, mediaUrl: "" });
  }
  return items;
}
