// Verifică modul „Postare clasică cu link" (ca dlvr.it): postarea merge pe
// /feed cu linkul articolului, textul = titlu + hashtag-uri, fără poză și
// fără comentariu. Pagina fără bifă rămâne pe postarea cu poză.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://runner@127.0.0.1:5433/social_test";
process.env.THROTTLE_MINUTES = "0";
process.env.STORIES_PER_DAY = "0";
process.env.BUSINESS_HOURS_START = "0";
process.env.BUSINESS_HOURS_END = "24";

import sharp from "sharp";
const JPEG = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 20, g: 60, b: 120 } } }).jpeg().toBuffer();
const iso = new Date(Date.now() - 20 * 60 * 1000).toISOString();
const calls = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("feed.test/rss")) {
    return new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>Stire Importanta De Test</title><link rel="alternate" href="http://feed.test/stire"/>
      <published>${iso}</published><updated>${iso}</updated></entry></feed>`, { status: 200 });
  }
  if (u.endsWith("feed.test/stire")) {
    return new Response(`<html><head><meta property="og:image" content="http://img.test/a.jpg"/></head><body>
      <div class="article-content"><p>${"Text. ".repeat(40)}</p></div></body></html>`, { status: 200 });
  }
  if (u.includes("img.test/")) return new Response(JPEG, { status: 200 });
  if (u.includes("graph.facebook.com")) {
    const b = opts.body;
    const tag = u.replace(/^.*v21\.0\//, "").split("?")[0];
    const get = (k) => (b && typeof b.get === "function" ? b.get(k) : null);
    calls.push({ tag, message: get("message"), link: get("link") });
    return new Response(JSON.stringify({ id: "FB_" + calls.length, post_id: "FB_" + calls.length }), { status: 200 });
  }
  throw new Error("fetch neașteptat: " + u);
};

const { pool, ensureSchema } = await import("../src/db.js");
const { runSocialPost } = await import("../src/cron.js");
await pool.query("DROP TABLE IF EXISTS external_fb_posts, cron_locks, sites CASCADE");
await ensureSchema();
await pool.query(`INSERT INTO sites (slug, name, feed_url, fb_page_id, fb_access_token, use_original_title, stories_enabled, link_post, hashtags) VALUES
  ('ziar', 'Ziar', 'http://feed.test/rss', 'P1', 'T', TRUE, FALSE, TRUE, '#botosani #stiribotosani'),
  ('clasic', 'Clasic', 'http://feed.test/rss', 'P2', 'T', TRUE, FALSE, FALSE, '')`);
await pool.query(`INSERT INTO external_fb_posts (page_id, item_url, fb_post_id) VALUES ('P1','__baseline__','baseline'),('P2','__baseline__','baseline')`);

let pass = 0, fail = 0;
const check = (n, c, x = "") => { if (c) { pass++; console.log(`  ✔ ${n}`); } else { fail++; console.log(`  ✘ ${n} ${x}`); } };

const dry = (await runSocialPost({ siteSlug: "ziar", dry: true })).results[0];
check("dry-run arată modul link și textul titlu + hashtag-uri",
  dry.wouldPost?.[0]?.mode === "link" && dry.wouldPost[0].caption === "Stire Importanta De Test #botosani #stiribotosani", JSON.stringify(dry));

const r = (await runSocialPost({ siteSlug: "ziar" })).results[0];
check("postarea cu link s-a publicat", r.posted?.mode === "link", JSON.stringify(r));
const ziarCalls = calls.filter((c) => c.tag.startsWith("P1"));
check("o singură cerere: /feed cu linkul articolului", ziarCalls.length === 1 && ziarCalls[0].tag === "P1/feed" && ziarCalls[0].link === "http://feed.test/stire", JSON.stringify(ziarCalls));
check("fără comentariu cu linkul", !calls.some((c) => c.tag.includes("/comments")));

const r2 = (await runSocialPost({ siteSlug: "clasic" })).results[0];
check("pagina fără bifă postează tot cu poză + comentariu",
  calls.some((c) => c.tag === "P2/photos") && calls.some((c) => c.tag.endsWith("/comments")), JSON.stringify(r2) + JSON.stringify(calls));

console.log(`\nREZULTAT: ${pass} ✔ / ${fail} ✘`);
await pool.end();
process.exit(fail ? 1 : 0);
