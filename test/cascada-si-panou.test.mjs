// Verifică: 1) cascada de publicare când Meta refuză pozele prin URL
// (album → foto-URL → upload fișier → card de brand), 2) panoul de admin:
// login, rate-limit, roluri admin/client, secțiunea „Articole care nu s-au
// putut posta" cu stările „se reîncearcă" / „expirat".
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://runner@127.0.0.1:5433/social_test";
process.env.THROTTLE_MINUTES = "0";
process.env.STORIES_PER_DAY = "0";
process.env.BUSINESS_HOURS_START = "0";
process.env.BUSINESS_HOURS_END = "24";
process.env.ADMIN_PASSWORD = "parola-admin-test";
process.env.CLIENT_PASSWORD = "parola-client-test";
process.env.CRON_SECRET = "secret-test";

import sharp from "sharp";
import express from "express";

const JPEG = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 120, g: 30, b: 30 } } }).jpeg().toBuffer();

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const state = { fbCalls: [] };

function atomFeed() {
  const entry = (slug, title, agoMs) => `
  <entry><title><![CDATA[ ${title} ]]></title>
    <link rel="alternate" href="http://feed.test/${slug}"/>
    <published>${iso(agoMs)}</published><updated>${iso(agoMs)}</updated>
  </entry>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  ${entry("fara-poza", "Articol Fara Nicio Poza", 30 * 60 * 1000)}
  ${entry("cu-poze", "Articol Cu Poze Refuzate Prin Url", 40 * 60 * 1000)}
</feed>`;
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("feed.test/rss2")) return new Response(atomFeed(), { status: 200 });
  if (u.endsWith("feed.test/cu-poze")) {
    return new Response(`<html><head><meta property="og:image" content="http://img.test/principala.jpg"/></head>
      <body><h1>t</h1><div class="article-content"><p>${"Text articol. ".repeat(30)}</p>
      <img src="http://feed.test/poze/secundara-mare.jpg"></div></body></html>`, { status: 200 });
  }
  if (u.endsWith("feed.test/fara-poza")) {
    return new Response(`<html><head></head><body><h1>t</h1>
      <div class="article-content"><p>${"Stire din surse, fara ilustratie. ".repeat(10)}</p></div></body></html>`, { status: 200 });
  }
  if (u.includes("img.test/") || u.includes("feed.test/poze/")) return new Response(JPEG, { status: 200 });
  if (u.includes("graph.facebook.com")) {
    const body = opts.body;
    if (!body) {
      // GET: tokenStatus / engagement
      return new Response(JSON.stringify({
        id: "X", name: "Pagina Test",
        reactions: { summary: { total_count: 5 } },
        comments: { summary: { total_count: 2 } },
        shares: { count: 1 },
      }), { status: 200 });
    }
    const isForm = typeof body.getAll === "function" && typeof body.has === "function" && !(body instanceof URLSearchParams);
    const get = (k) => (typeof body.get === "function" ? body.get(k) : null);
    const tag = u.replace(/^.*v21\.0\//, "").split("?")[0];
    if (body instanceof URLSearchParams && get("url")) {
      state.fbCalls.push(`${tag} URL-REFUZAT`);
      return new Response(JSON.stringify({ error: { message: "Meta refuză URL-ul pozei (simulat)" } }), { status: 400 });
    }
    state.fbCalls.push(`${tag} ${isForm ? "MULTIPART-OK" : "OK"}`);
    const id = "FBID_" + state.fbCalls.length;
    return new Response(JSON.stringify({ id, post_id: id, success: true }), { status: 200 });
  }
  throw new Error("fetch neașteptat în test: " + u);
};

const { pool, ensureSchema } = await import("../src/db.js");
const { runSocialPost } = await import("../src/cron.js");
const { admin } = await import("../src/admin.js");

await pool.query("DROP TABLE IF EXISTS external_fb_posts, cron_locks, sites CASCADE");
await ensureSchema();
await pool.query(
  `INSERT INTO sites (slug, name, feed_url, fb_page_id, fb_access_token, use_original_title, stories_enabled)
   VALUES ('testsite', 'Test Site', 'http://feed.test/rss2', 'PAGE1', 'TOK', TRUE, FALSE)`
);
await pool.query(`INSERT INTO external_fb_posts (page_id, item_url, fb_post_id) VALUES ('PAGE1', '__baseline__', 'baseline')`);

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name} ${extra}`); }
};

console.log("— Cascada de publicare —");
const r1 = (await runSocialPost({ siteSlug: "testsite" })).results[0];
check("Meta refuză pozele prin URL → articolul se publică totuși (upload ca fișier)",
  r1.posted?.link === "http://feed.test/cu-poze" && /^FBID_/.test(r1.posted?.fbPostId), JSON.stringify(r1));
check("s-au încercat întâi albumul și foto-URL (refuzate), apoi multipart",
  state.fbCalls.some((c) => c.includes("URL-REFUZAT")) && state.fbCalls.some((c) => c.includes("photos MULTIPART-OK")),
  JSON.stringify(state.fbCalls));

const r2 = (await runSocialPost({ siteSlug: "testsite" })).results[0];
check("articolul FĂRĂ nicio poză se publică cu cardul de brand (multipart)",
  r2.posted?.link === "http://feed.test/fara-poza", JSON.stringify(r2));
check("ambele postări au primit linkul în primul comentariu",
  state.fbCalls.filter((c) => c.startsWith("FBID_") && c.includes("/comments")).length === 2
  || state.fbCalls.filter((c) => c.includes("/comments")).length === 2, JSON.stringify(state.fbCalls));

console.log("— Panoul de admin —");
// rânduri de „probleme": unul în carantină, unul expirat definitiv
await pool.query(`INSERT INTO external_fb_posts (page_id, item_url, fb_post_id, last_error) VALUES
  ('PAGE1', 'http://feed.test/articol-in-carantina', NULL, 'eroare temporară (simulată)'),
  ('PAGE1', 'http://feed.test/articol-expirat', 'failed', 'Meta refuză (simulat)')`);

const app = express();
app.use("/admin", admin);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const post = (path, bodyStr, headers = {}) =>
  fetchRaw(`${base}${path}`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: bodyStr });
async function fetchRaw(u, opts) {
  // ruta locală de test: ocolește mock-ul global
  const http = await import("http");
  return new Promise((resolve, reject) => {
    const req = http.request(u, { method: opts.method || "GET", headers: opts.headers || {} }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// rate-limit: 10 încercări greșite de pe același IP → a 11-a primește 429
for (let i = 0; i < 10; i++) await post("/admin/login", "password=gresit", { "x-forwarded-for": "9.9.9.9" });
const blocked = await post("/admin/login", "password=gresit", { "x-forwarded-for": "9.9.9.9" });
check("după 10 încercări greșite loginul e blocat (429)", blocked.status === 429, `status=${blocked.status}`);

const adminLogin = await post("/admin/login", "password=parola-admin-test", { "x-forwarded-for": "1.1.1.1" });
const adminCookie = (adminLogin.headers["set-cookie"] || [])[0]?.split(";")[0] || "";
check("login admin reușit (redirect + cookie)", adminLogin.status === 302 && adminCookie.startsWith("adm="));

const detail = await fetchRaw(`${base}/admin/sites/testsite`, { headers: { cookie: adminCookie } });
check("pagina site-ului se încarcă pentru admin", detail.status === 200, `status=${detail.status}`);
check("secțiunea de erori apare cu ambele articole",
  detail.text.includes("Articole care nu s-au putut posta")
  && detail.text.includes("articol-in-carantina") && detail.text.includes("articol-expirat"));
check("stările sunt diferențiate („se reîncearcă” vs „expirat”)",
  detail.text.includes("se reîncearcă") && detail.text.includes("expirat (nu se mai reîncearcă)"));
check("marker-ul 'failed' NU apare în istoricul de postări ca link spre FB",
  !detail.text.includes("facebook.com/failed"));
check("statisticile numără doar postările reale (2)",
  / class="stat-n">2<\/div><div class="stat-l">postări în 24h/.test(detail.text.replace(/\s+/g, " ")) ||
  detail.text.includes(`<div class="stat-n">2</div>`));

const clientLogin = await post("/admin/login", "password=parola-client-test", { "x-forwarded-for": "1.1.1.2" });
const clientCookie = (clientLogin.headers["set-cookie"] || [])[0]?.split(";")[0] || "";
check("login client reușit", clientLogin.status === 302 && clientCookie.startsWith("adm="));

const cView = await fetchRaw(`${base}/admin/sites/testsite`, { headers: { cookie: clientCookie } });
check("clientul VEDE pagina site-ului", cView.status === 200);
const cEdit = await fetchRaw(`${base}/admin/sites/testsite/edit`, { headers: { cookie: clientCookie } });
check("clientul NU poate intra la setări (403)", cEdit.status === 403, `status=${cEdit.status}`);
const cCreate = await post("/admin/sites", "slug=hack&name=x&feed_url=http://x", { cookie: clientCookie });
check("clientul NU poate crea/modifica site-uri (403)", cCreate.status === 403, `status=${cCreate.status}`);

const noAuth = await fetchRaw(`${base}/admin/sites/testsite`, { headers: {} });
check("fără login → redirect la /admin/login", noAuth.status === 302 && /\/admin\/login/.test(noAuth.headers.location || ""));

server.close();
console.log(`\nREZULTAT: ${pass} ✔ / ${fail} ✘`);
await pool.end();
process.exit(fail ? 1 : 0);
