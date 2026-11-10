// Cron cap-coadă cu filtrul „Doar categoriile": din feed se postează doar
// articolele care apar în paginile de categorie; dacă nicio pagină de
// categorie nu se încarcă, nu se postează nimic.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://runner@127.0.0.1:5433/social_test";
process.env.THROTTLE_MINUTES = "0";
process.env.STORIES_PER_DAY = "0";
process.env.BUSINESS_HOURS_START = "0";
process.env.BUSINESS_HOURS_END = "24";

const iso = new Date(Date.now() - 20 * 60 * 1000).toISOString();
let categoriiPica = false;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u === "http://feed.test/rss-cat") {
    const e = (slug) => `<entry><title><![CDATA[Titlu ${slug}]]></title><link rel="alternate" href="https://www.botosaneanul.ro/${slug}"/><published>${iso}</published><updated>${iso}</updated></entry>`;
    return new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${e("stire-banala")}${e("stirea-zilei-de-azi")}</feed>`);
  }
  if (u === "https://www.botosaneanul.ro/stirea-zilei") {
    if (categoriiPica) return new Response("eroare", { status: 503 });
    return new Response(`<script type="application/ld+json">{"@type":"CollectionPage","mainEntity":{"@type":"ItemList","itemListElement":[{"@type":"ListItem","position":1,"url":"https://www.botosaneanul.ro/stirea-zilei-de-azi"}]}}</script>`);
  }
  if (u.startsWith("https://www.botosaneanul.ro/")) {
    return new Response(`<html><body><div class="article-content"><p>${"Text de articol suficient de lung. ".repeat(12)}</p></div></body></html>`);
  }
  throw new Error("fetch neașteptat în test: " + u);
};

const { pool, ensureSchema } = await import("../src/db.js");
const { runSocialPost } = await import("../src/cron.js");

await pool.query("DROP TABLE IF EXISTS external_fb_posts, cron_locks, sites CASCADE");
await ensureSchema();
await pool.query(
  `INSERT INTO sites (slug, name, feed_url, fb_page_id, fb_access_token, stories_enabled, use_original_title, include_pages)
   VALUES ('ziar', 'Ziar', 'http://feed.test/rss-cat', 'PAGEZ', 'TOK', FALSE, TRUE, 'https://www.botosaneanul.ro/stirea-zilei')`
);

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); } else { fail++; console.log(`  ✘ ${name} ${extra}`); }
};

console.log("— Doar categoriile —");
const r = (await runSocialPost({ siteSlug: "ziar", dry: true })).results[0];
const links = (r.wouldPost || []).map((w) => w.link || w.url || JSON.stringify(w));
check("se postează articolul din categorie", links.some((l) => l.includes("stirea-zilei-de-azi")), JSON.stringify(r));
check("NU se postează articolul din afara categoriilor", !links.some((l) => l.includes("stire-banala")), JSON.stringify(links));

categoriiPica = true;
const r2 = (await runSocialPost({ siteSlug: "ziar", dry: true })).results[0];
check("pagina de categorie picată → nu se postează nimic", !(r2.wouldPost || []).length && /categorii/.test(r2.error || ""), JSON.stringify(r2));

console.log(`\nREZULTAT: ${pass} ✔ / ${fail} ✘`);
await pool.end();
process.exit(fail ? 1 : 0);
