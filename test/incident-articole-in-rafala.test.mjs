// Reproduce incidentul din 27.08: 3 articole publicate la câteva minute
// distanță; unul e refuzat de Meta la toate variantele. Verifică:
//  1) postare în ordinea publicării (cel mai vechi primul)
//  2) articolul stricat NU blochează restul rulării
//  3) carantina de 20 min pentru articolul stricat
//  4) după 24h de eșecuri: marcat 'failed', vizibil în panou, NU dispare
//  5) 'failed' nu declanșează throttle și nu devine candidat de Story
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://runner@127.0.0.1:5433/social_test";
process.env.THROTTLE_MINUTES = "0";
process.env.STORIES_PER_DAY = "0";
process.env.BUSINESS_HOURS_START = "0";
process.env.BUSINESS_HOURS_END = "24";

import sharp from "sharp";

const JPEG = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 60, b: 120 } } }).jpeg().toBuffer();

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

// stare controlabilă din test
const state = { bPublishedAgo: 35 * 60 * 1000, fbCalls: [] };

function atomFeed() {
  const entry = (slug, title, agoMs) => `
  <entry>
    <title><![CDATA[ ${title} ]]></title>
    <link rel="alternate" href="http://feed.test/${slug}"/>
    <published>${iso(agoMs)}</published>
    <updated>${iso(agoMs)}</updated>
    <summary><![CDATA[ Rezumat pentru ${title}. ]]></summary>
  </entry>`;
  // feed-ul listează INVERS cronologic (cel mai nou primul), ca în realitate
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test</title>
  ${entry("articol-c", "Articol Trei Cel Mai Nou", 30 * 60 * 1000)}
  ${entry("articol-b", "Articol Doi STRICAT De Meta", state.bPublishedAgo)}
  ${entry("articol-a", "Articol Unu Cel Mai Vechi", 40 * 60 * 1000)}
</feed>`;
}

function articleHtml(slug, title) {
  return `<html><head>
    <meta property="og:title" content="${title}"/>
    <meta property="og:image" content="http://img.test/${slug}.jpg"/>
  </head><body><h1>${title}</h1>
  <div class="article-content"><p>${"Text real al articolului. ".repeat(20)}</p>
  <img src="http://feed.test/poze/${slug}-mare.jpg"></div></body></html>`;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("feed.test/rss")) return new Response(atomFeed(), { status: 200 });
  if (u.match(/feed\.test\/articol-([abc])$/)) {
    const slug = u.split("/").pop();
    const titles = { "articol-a": "Articol Unu Cel Mai Vechi", "articol-b": "Articol Doi STRICAT De Meta", "articol-c": "Articol Trei Cel Mai Nou" };
    return new Response(articleHtml(slug, titles[slug]), { status: 200 });
  }
  if (u.includes("img.test/") || u.includes("feed.test/poze/")) {
    return new Response(JPEG, { status: 200 });
  }
  if (u.includes("graph.facebook.com")) {
    const body = opts.body;
    const get = (k) => (body && typeof body.get === "function" ? body.get(k) : null);
    const text = `${get("caption") || ""} ${get("message") || ""}`;
    state.fbCalls.push(u.replace(/^.*v21\.0\//, "") + " :: " + text.slice(0, 40));
    if (text.includes("STRICAT")) {
      return new Response(JSON.stringify({ error: { message: "Meta refuză (simulat)" } }), { status: 400 });
    }
    const id = "FBID_" + state.fbCalls.length;
    return new Response(JSON.stringify({ id, post_id: id, success: true }), { status: 200 });
  }
  return realFetch(url, opts);
};

const { pool, ensureSchema } = await import("../src/db.js");
const { runSocialPost } = await import("../src/cron.js");

await pool.query("DROP TABLE IF EXISTS external_fb_posts, cron_locks, sites CASCADE");
await ensureSchema();
await pool.query(
  `INSERT INTO sites (slug, name, feed_url, fb_page_id, fb_access_token, use_original_title, stories_enabled)
   VALUES ('testsite', 'Test Site', 'http://feed.test/rss', 'PAGE1', 'TOK', TRUE, FALSE)`
);
// sărim peste prima activare (baseline) ca articolele să conteze ca NOI
await pool.query(
  `INSERT INTO external_fb_posts (page_id, item_url, fb_post_id) VALUES ('PAGE1', '__baseline__', 'baseline')`
);

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name} ${extra}`); }
};

console.log("— Rularea 1: rafală de 3 articole noi —");
const r1 = (await runSocialPost({ siteSlug: "testsite" })).results[0];
check("postează PRIMUL articol publicat (cel mai vechi), nu cel mai nou din feed",
  r1.posted?.link === "http://feed.test/articol-a", JSON.stringify(r1));

console.log("— Rularea 2: următorul la rând e cel STRICAT —");
const r2 = (await runSocialPost({ siteSlug: "testsite" })).results[0];
check("articolul stricat eșuează dar NU blochează rularea — se postează următorul",
  r2.posted?.link === "http://feed.test/articol-c", JSON.stringify(r2));
check("eroarea articolului stricat e raportată în rezultat",
  r2.errors?.length === 1 && r2.errors[0].item === "http://feed.test/articol-b");
const { rows: [bRow] } = await pool.query(
  `SELECT fb_post_id, last_error FROM external_fb_posts WHERE item_url = 'http://feed.test/articol-b'`);
check("claim-ul stricat rămâne în carantină cu eroarea salvată",
  bRow && bRow.fb_post_id === null && /Meta refuză/.test(bRow.last_error || ""), JSON.stringify(bRow));

console.log("— Rularea 3: carantină activă —");
const r3 = (await runSocialPost({ siteSlug: "testsite" })).results[0];
check("în carantină (sub 20 min) nu se reîncearcă nimic",
  r3.posted === null && !r3.errors, JSON.stringify(r3));

console.log("— Rularea 4: carantina expiră → retry, eșuează iar —");
await pool.query(`UPDATE external_fb_posts SET posted_at = NOW() - INTERVAL '25 minutes'
                  WHERE item_url = 'http://feed.test/articol-b'`);
const r4 = (await runSocialPost({ siteSlug: "testsite" })).results[0];
check("după carantină se reîncearcă și eroarea se salvează din nou",
  r4.errors?.length === 1 && r4.posted === null, JSON.stringify(r4));

console.log("— Rularea 5: articolul stricat împlinește 24h —");
state.bPublishedAgo = 25 * 3600 * 1000; // feed-ul îl arată acum ca vechi de 25h
await pool.query(`UPDATE external_fb_posts SET posted_at = NOW() - INTERVAL '22 minutes'
                  WHERE item_url = 'http://feed.test/articol-b'`);
const r5 = (await runSocialPost({ siteSlug: "testsite" })).results[0];
const { rows: [bFinal] } = await pool.query(
  `SELECT fb_post_id, last_error FROM external_fb_posts WHERE item_url = 'http://feed.test/articol-b'`);
check("expirat: marcat 'failed' definitiv, cu eroarea păstrată (NU dispare tăcut)",
  bFinal && bFinal.fb_post_id === "failed" && /Meta refuză/.test(bFinal.last_error || ""), JSON.stringify(bFinal));
check("rularea 5 nu mai reîncearcă articolul expirat", !r5.errors, JSON.stringify(r5));

// interogarea din panou („Articole care nu s-au putut posta") îl vede
const { rows: probs } = await pool.query(
  `SELECT item_url FROM external_fb_posts
   WHERE page_id = 'PAGE1' AND last_error IS NOT NULL AND (fb_post_id IS NULL OR fb_post_id = 'failed')`);
check("panoul îl afișează la „Articole care nu s-au putut posta\"",
  probs.some((p) => p.item_url === "http://feed.test/articol-b"));

// 'failed' NU declanșează throttle
const { rowCount: thr } = await pool.query(
  `SELECT 1 FROM external_fb_posts
   WHERE page_id = 'PAGE1' AND fb_post_id IS NOT NULL AND fb_post_id NOT IN ('baseline','filtered','failed')
     AND posted_at > NOW() - make_interval(mins => 15) AND item_url = 'http://feed.test/articol-b'`);
check("'failed' nu contează la throttle", thr === 0);

// 'failed' NU e candidat de Story
const { rows: cand } = await pool.query(
  `SELECT item_url FROM external_fb_posts
   WHERE page_id = 'PAGE1' AND fb_post_id IS NOT NULL AND fb_post_id NOT IN ('baseline','filtered','failed')
     AND story_id IS NULL AND posted_at > NOW() - INTERVAL '24 hours' ORDER BY posted_at ASC`);
check("'failed' nu e candidat de Story", !cand.some((c) => c.item_url === "http://feed.test/articol-b"));

// postările reale au primit link-ul în PRIMUL COMENTARIU
const comments = state.fbCalls.filter((c) => c.includes("/comments"));
check("linkul e pus în primul comentariu la ambele postări reușite",
  comments.length === 2 && comments.every((c) => c.includes("Citește articolul")), JSON.stringify(comments));

console.log(`\nREZULTAT: ${pass} ✔ / ${fail} ✘`);
await pool.end();
process.exit(fail ? 1 : 0);
