import { pool } from "./db.js";

// Config de pornire: la prima rulare (tabel `sites` gol) se inserează
// site-urile de aici, cu valorile din env dacă există. După aceea, sursa
// de adevăr e tabelul `sites`, administrat din panoul de admin.
const DEFAULT_SITES = [
  {
    slug: "botosaneanul",
    name: "Botoșăneanul",
    feed_url: process.env.BOTOSANEANUL_FEED_URL || "https://www.botosaneanul.ro/rss",
    fb_page_id: process.env.BOTOSANEANUL_FB_PAGE_ID || "",
    fb_access_token: process.env.BOTOSANEANUL_FB_ACCESS_TOKEN || "",
    openai_api_key: process.env.BOTOSANEANUL_OPENAI_API_KEY || "",
  },
  {
    slug: "martor-incomod",
    name: "Martor Incomod",
    feed_url: process.env.MARTOR_FEED_URL || "https://www.martorincomod.ro/feed/",
    fb_page_id: process.env.MARTOR_FB_PAGE_ID || "",
    fb_access_token: process.env.MARTOR_FB_ACCESS_TOKEN || "",
    openai_api_key: process.env.MARTOR_OPENAI_API_KEY || "",
  },
];

// Site-urile default lipsă se adaugă la fiecare pornire (ON CONFLICT DO
// NOTHING — ce există deja în DB nu se atinge). Un site nou apare
// neconfigurat și doar aștepți să-i pui tokenul din /admin.
export async function seedSitesFromEnv() {
  for (const s of DEFAULT_SITES) {
    await pool.query(
      `INSERT INTO sites (slug, name, feed_url, fb_page_id, fb_access_token, openai_api_key, active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (slug) DO NOTHING`,
      [s.slug, s.name, s.feed_url, s.fb_page_id, s.fb_access_token, s.openai_api_key]
    );
  }
}

export async function getSites({ activeOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM sites ${activeOnly ? "WHERE active" : ""} ORDER BY slug`
  );
  return rows;
}

export async function getSite(slug) {
  const { rows } = await pool.query(`SELECT * FROM sites WHERE slug = $1`, [slug]);
  return rows[0] || null;
}

export async function upsertSite({ slug, name, feed_url, fb_page_id, fb_access_token, openai_api_key }) {
  // câmpurile secrete goale la editare = păstrează valoarea existentă
  await pool.query(
    `INSERT INTO sites (slug, name, feed_url, fb_page_id, fb_access_token, openai_api_key, active)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       feed_url = EXCLUDED.feed_url,
       fb_page_id = EXCLUDED.fb_page_id,
       fb_access_token = CASE WHEN EXCLUDED.fb_access_token = '' THEN sites.fb_access_token ELSE EXCLUDED.fb_access_token END,
       openai_api_key = CASE WHEN EXCLUDED.openai_api_key = '' THEN sites.openai_api_key ELSE EXCLUDED.openai_api_key END,
       updated_at = NOW()`,
    [slug, name, feed_url, fb_page_id, fb_access_token || "", openai_api_key || ""]
  );
}

export async function setSiteActive(slug, active) {
  await pool.query(`UPDATE sites SET active = $2, updated_at = NOW() WHERE slug = $1`, [slug, active]);
}

export async function deleteSite(slug) {
  await pool.query(`DELETE FROM sites WHERE slug = $1`, [slug]);
}
