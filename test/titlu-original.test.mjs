// Verifică LA SÂNGE combinațiile bifelor din pagina „Stil”:
//   use_original_title × details_line → captionul exact al postării
// (prin dry-run, care raportează captionul fără să posteze nimic).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://runner@127.0.0.1:5433/social_test";
process.env.THROTTLE_MINUTES = "0";
process.env.STORIES_PER_DAY = "0";
process.env.BUSINESS_HOURS_START = "0";
process.env.BUSINESS_HOURS_END = "24";

const TITLE = "Titlu Original De Test Exact Cum A Fost Publicat";
const iso = new Date(Date.now() - 30 * 60 * 1000).toISOString();

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("feed.test/rss3")) {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title><![CDATA[ ${TITLE} ]]></title>
    <link rel="alternate" href="http://feed.test/articol-titlu"/>
    <published>${iso}</published><updated>${iso}</updated>
  </entry>
</feed>`, { status: 200 });
  }
  if (u.endsWith("feed.test/articol-titlu")) {
    return new Response(`<html><body><h1>t</h1><div class="article-content">
      <p>${"Text suficient de lung ca sa nu fie considerat sarac. ".repeat(10)}</p></div></body></html>`, { status: 200 });
  }
  throw new Error("fetch neașteptat în test: " + u);
};

const { pool, ensureSchema } = await import("../src/db.js");
const { runSocialPost } = await import("../src/cron.js");
const { DETAILS_LINE } = await import("../src/lib/caption.js");

await pool.query("DROP TABLE IF EXISTS external_fb_posts, cron_locks, sites CASCADE");
await ensureSchema();
await pool.query(
  `INSERT INTO sites (slug, name, feed_url, fb_page_id, fb_access_token, stories_enabled)
   VALUES ('testsite', 'Test Site', 'http://feed.test/rss3', 'PAGE1', 'TOK', FALSE)`
);

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name} ${extra}`); }
};

async function dryCaption(useOriginal, detailsLine) {
  await pool.query(`UPDATE sites SET use_original_title = $1, details_line = $2 WHERE slug = 'testsite'`,
    [useOriginal, detailsLine]);
  const r = (await runSocialPost({ siteSlug: "testsite", dry: true })).results[0];
  return r.wouldPost?.[0]?.caption;
}

console.log("— Combinațiile bifelor de stil —");
check("titlu original PORNIT, rând de detalii OPRIT → postarea e EXACT titlul",
  (await dryCaption(true, false)) === TITLE);
check("titlu original PORNIT, rând de detalii PORNIT → titlul + rândul cu 📌",
  (await dryCaption(true, true)) === `${TITLE}\n\n${DETAILS_LINE}`);
check("titlu original OPRIT (fără cheie AI) → fallback: titlul + rândul cu 📌",
  (await dryCaption(false, false)) === `${TITLE}\n\n${DETAILS_LINE}`);
check("bifa de detalii NU schimbă nimic când titlul original e oprit (fallback-ul o are deja)",
  (await dryCaption(false, true)) === `${TITLE}\n\n${DETAILS_LINE}`);

// dry-run nu lasă urme: claimurile se eliberează, nimic nu rămâne „văzut"
const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM external_fb_posts WHERE page_id = 'PAGE1'`);
check("dry-run nu lasă claimuri în urmă", rows[0].n === 0, `rows=${rows[0].n}`);

console.log(`\nREZULTAT: ${pass} ✔ / ${fail} ✘`);
await pool.end();
process.exit(fail ? 1 : 0);
