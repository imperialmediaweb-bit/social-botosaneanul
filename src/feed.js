import express from "express";
import { getSite } from "./sites.js";
import { fetchFeedItems } from "./lib/rss.js";
import { fetchAllowedLinks, normalizeUrl, parseIncludePages } from "./lib/categories.js";

// Feed RSS public, FILTRAT pe categoriile paginii (ex. Ziarul Botoșăneanul:
// doar cele 7 categorii importante). Pentru servicii externe care nu știu să
// filtreze singure — de ex. dlvr.it → Reddit.
//   GET /feed/<slug>.xml
// Rezultatul se ține 10 minute în memorie, ca să nu citim paginile de
// categorie la fiecare interogare.
export const feed = express.Router();
const cache = new Map();
const TTL_MS = 10 * 60 * 1000;

const xml = (s) => String(s || "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function buildFilteredFeed(site) {
  let items = await fetchFeedItems(site.feed_url);
  const pages = parseIncludePages(site.include_pages);
  if (pages.length) {
    const { allowed, ok } = await fetchAllowedLinks(pages);
    // nicio pagină de categorie citită → feed gol (nu scăpăm știri din alte categorii)
    items = ok === 0 ? [] : items.filter((it) => allowed.has(normalizeUrl(it.link)));
  }
  const entries = items.slice(0, 30).map((it) => `
    <item>
      <title>${xml(it.title)}</title>
      <link>${xml(it.link)}</link>
      <guid isPermaLink="true">${xml(it.link)}</guid>
      ${it.publishedAt ? `<pubDate>${new Date(it.publishedAt).toUTCString()}</pubDate>` : ""}
      ${it.mediaUrl ? `<enclosure url="${xml(it.mediaUrl)}" type="image/jpeg"/>` : ""}
    </item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xml(site.name)}</title>
    <link>${xml(site.feed_url.replace(/\/rss\/?$|\/feed\/?$/, ""))}</link>
    <description>${xml(site.name)} — știrile selectate automat</description>${entries}
  </channel>
</rss>`;
}

feed.get("/:slug.xml", async (req, res, next) => {
  try {
    const site = await getSite(req.params.slug);
    if (!site || !site.active) return res.status(404).type("text/plain").send("feed inexistent");
    const hit = cache.get(site.slug);
    let body = hit && Date.now() - hit.at < TTL_MS ? hit.body : null;
    if (!body) {
      body = await buildFilteredFeed(site);
      cache.set(site.slug, { at: Date.now(), body });
    }
    res.type("application/rss+xml; charset=utf-8").send(body);
  } catch (e) {
    next(e);
  }
});
