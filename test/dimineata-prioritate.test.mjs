// Scenariul de dimineață raportat pe 08.09: peste noapte (orar închis 22-06)
// se adună articole nepostate; la 6:00+ redacția publică știri noi și le vrea
// pe pagină IMEDIAT. Verifică:
//  1) articolul PROASPĂT (ultimele 3h) trece în FAȚA restanțelor de peste noapte
//  2) în interiorul fiecărei trepte se păstrează ordinea publicării
//  3) restanțele se golesc după ce nu mai e nimic proaspăt
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://runner@127.0.0.1:5433/social_test";
process.env.THROTTLE_MINUTES = "0";
process.env.STORIES_PER_DAY = "0";
process.env.BUSINESS_HOURS_START = "0";
process.env.BUSINESS_HOURS_END = "24";

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const H = 3600 * 1000;
const MIN = 60 * 1000;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("feed.test/rss4")) {
    const entry = (slug, title, agoMs) => `
  <entry><title><![CDATA[ ${title} ]]></title>
    <link rel="alternate" href="http://feed.test/${slug}"/>
    <published>${iso(agoMs)}</published><updated>${iso(agoMs)}</updated>
  </entry>`;
    // feed invers cronologic, ca în realitate
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  ${entry("proaspat-2", "Stire Proaspata De La Ora Sapte", 20 * MIN)}
  ${entry("proaspat-1", "Stire Proaspata De La Sase Jumate", 50 * MIN)}
  ${entry("restanta-2", "Restanta De La Patru Dimineata", 4 * H)}
  ${entry("restanta-1", "Restanta De La Miezul Noptii", 8 * H)}
</feed>`, { status: 200 });
  }
  if (u.match(/feed\.test\/(proaspat|restanta)-\d$/)) {
    return new Response(`<html><body><h1>t</h1><div class="article-content">
      <p>${"Text de articol suficient de lung. ".repeat(15)}</p></div></body></html>`, { status: 200 });
  }
  if (u.includes("graph.facebook.com")) {
    const id = "FBID_" + Math.random().toString(36).slice(2, 8);
    return new Response(JSON.stringify({ id, post_id: id, success: true }), { status: 200 });
  }
  throw new Error("fetch neașteptat în test: " + u);
};

const { pool, ensureSchema } = await import("../src/db.js");
const { runSocialPost } = await import("../src/cron.js");

await pool.query("DROP TABLE IF EXISTS external_fb_posts, cron_locks, sites CASCADE");
await ensureSchema();
await pool.query(
  `INSERT INTO sites (slug, name, feed_url, fb_page_id, fb_access_token, use_original_title, stories_enabled)
   VALUES ('testsite', 'Test Site', 'http://feed.test/rss4', 'PAGE1', 'TOK', TRUE, FALSE)`
);
await pool.query(`INSERT INTO external_fb_posts (page_id, item_url, fb_post_id) VALUES ('PAGE1', '__baseline__', 'baseline')`);

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name} ${extra}`); }
};

const postedOrder = [];
for (let i = 0; i < 5; i++) {
  const r = (await runSocialPost({ siteSlug: "testsite" })).results[0];
  if (r.posted) postedOrder.push(r.posted.link.split("/").pop());
}

console.log("— Prioritatea de dimineață —");
check("4 articole postate în 4 rulări", postedOrder.length === 4, JSON.stringify(postedOrder));
check("PROASPETELE trec înaintea restanțelor de peste noapte",
  postedOrder[0]?.startsWith("proaspat") && postedOrder[1]?.startsWith("proaspat"),
  JSON.stringify(postedOrder));
check("în treapta proaspătă: ordinea publicării (6:30 înainte de 7:00)",
  postedOrder[0] === "proaspat-1" && postedOrder[1] === "proaspat-2", JSON.stringify(postedOrder));
check("restanțele se golesc apoi, tot în ordinea publicării",
  postedOrder[2] === "restanta-1" && postedOrder[3] === "restanta-2", JSON.stringify(postedOrder));

console.log(`\nREZULTAT: ${pass} ✔ / ${fail} ✘`);
await pool.end();
process.exit(fail ? 1 : 0);
