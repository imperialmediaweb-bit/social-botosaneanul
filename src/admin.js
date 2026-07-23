import express from "express";
import crypto from "crypto";
import { pool } from "./db.js";
import { getSites, getSite, upsertSite, setSiteActive, deleteSite } from "./sites.js";
import { runSocialPost } from "./cron.js";

export const admin = express.Router();

// ---------- autentificare (parolă din ADMIN_PASSWORD, cookie semnat) ----------

function cookieToken() {
  return crypto
    .createHmac("sha256", process.env.CRON_SECRET || "no-secret")
    .update(process.env.ADMIN_PASSWORD || "")
    .digest("hex");
}

function isAuthed(req) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => {
      const i = c.indexOf("=");
      return i === -1 ? [c.trim(), ""] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
    })
  );
  return !!process.env.ADMIN_PASSWORD && cookies.adm === cookieToken();
}

admin.use(express.urlencoded({ extended: false }));

admin.use((req, res, next) => {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(503).send(page("Admin dezactivat", `<p>Setează variabila de mediu <code>ADMIN_PASSWORD</code> în Railway ca să activezi panoul.</p>`));
  }
  if (req.path === "/login") return next();
  if (!isAuthed(req)) return res.redirect("/admin/login");
  next();
});

admin.get("/login", (req, res) => {
  res.send(page("Login", `
    <form method="post" action="/admin/login" class="card">
      <h2>🔐 Panou de administrare</h2>
      <label>Parola</label>
      <input type="password" name="password" autofocus>
      <button type="submit">Intră</button>
    </form>`));
});

admin.post("/login", (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    res.setHeader("Set-Cookie", `adm=${cookieToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return res.redirect("/admin");
  }
  res.send(page("Login", `<form method="post" action="/admin/login" class="card">
    <h2>🔐 Panou de administrare</h2>
    <p class="err">Parolă greșită.</p>
    <label>Parola</label><input type="password" name="password" autofocus>
    <button type="submit">Intră</button></form>`));
});

admin.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "adm=; Path=/; Max-Age=0");
  res.redirect("/admin/login");
});

// ---------- dashboard ----------

// Starea tokenului, verificată live la încărcarea dashboardului (timeout
// scurt ca pagina să nu atârne dacă Graph API e lent).
async function tokenStatus(site) {
  if (!site.fb_page_id || !site.fb_access_token) return { state: "unconfigured" };
  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(site.fb_page_id)}?fields=id,name&access_token=${encodeURIComponent(site.fb_access_token)}`,
      { signal: AbortSignal.timeout(6000), cache: "no-store" }
    );
    const data = await r.json();
    if (data.error) return { state: "invalid", message: data.error.message || "token invalid" };
    return { state: "ok", pageName: data.name };
  } catch {
    return { state: "unknown" };
  }
}

admin.get("/", async (req, res) => {
  const sites = await getSites();
  const statuses = await Promise.all(sites.map(tokenStatus));
  const { rows: lastPosts } = await pool.query(
    `SELECT p.page_id, p.item_url, p.fb_post_id, p.posted_at, s.name AS site_name
     FROM external_fb_posts p
     LEFT JOIN sites s ON s.fb_page_id = p.page_id
     WHERE p.fb_post_id IS NOT NULL
     ORDER BY p.posted_at DESC LIMIT 20`
  );

  const siteRows = await Promise.all(sites.map(async (s, i) => {
    const { rows } = await pool.query(
      `SELECT MAX(posted_at) AS last, COUNT(*)::int AS n
       FROM external_fb_posts WHERE page_id = $1 AND fb_post_id IS NOT NULL`,
      [s.fb_page_id || "-"]
    );
    const st = statuses[i];
    const tokenCell =
      st.state === "ok" ? `✅ <b>${esc(st.pageName)}</b><br><small>${esc(s.fb_page_id)}</small>` :
      st.state === "invalid" ? `❌ <span class="err">TOKEN MORT</span><br><small>${esc(st.message.slice(0, 90))}</small><br><small>→ regenerează tokenul și pune-l la ✏️ Editează</small>` :
      st.state === "unconfigured" ? `⚠️ neconfigurat` :
      `❓ ${esc(s.fb_page_id)} <small>(Graph API n-a răspuns)</small>`;
    return `<tr>
      <td><b>${esc(s.name)}</b><br><small>${esc(s.slug)}</small></td>
      <td><small>${esc(s.feed_url)}</small></td>
      <td>${tokenCell}</td>
      <td>${s.active ? "🟢 activ" : "⏸️ oprit"}</td>
      <td><small>${rows[0].n} postări${rows[0].last ? `<br>ultima: ${fmtDate(rows[0].last)}` : ""}</small></td>
      <td class="actions">
        <a class="btn" href="/admin/sites/${esc(s.slug)}/edit">✏️ Editează</a>
        <form method="post" action="/admin/sites/${esc(s.slug)}/check"><button>🔎 Verifică token</button></form>
        <form method="post" action="/admin/sites/${esc(s.slug)}/dry-run"><button>🧪 Dry-run</button></form>
        <form method="post" action="/admin/sites/${esc(s.slug)}/run-now" onsubmit="return confirm('Postează ACUM pe Facebook primul articol nepostat. Continui?')"><button class="warn">🚀 Postează acum</button></form>
        <form method="post" action="/admin/sites/${esc(s.slug)}/toggle"><button>${s.active ? "⏸️ Oprește" : "▶️ Pornește"}</button></form>
      </td>
    </tr>`;
  }));

  const postRows = lastPosts.map((p) => `<tr>
    <td><small>${fmtDate(p.posted_at)}</small></td>
    <td>${esc(p.site_name || p.page_id)}</td>
    <td><a href="${esc(p.item_url)}" target="_blank"><small>${esc(p.item_url.slice(0, 80))}</small></a></td>
    <td>${p.fb_post_id ? `<a href="https://www.facebook.com/${esc(p.fb_post_id)}" target="_blank">vezi pe FB</a>` : "-"}</td>
  </tr>`).join("");

  res.send(page("Dashboard", `
    <div class="topbar"><h1>📣 Social Bot — administrare</h1>
      <span><a class="btn" href="/admin/fb/connect">🔗 Conectează pagini cu Facebook</a>
      <a class="btn" href="/admin/sites/new">➕ Adaugă site</a> <a class="btn" href="/admin/logout">Ieși</a></span></div>
    <div class="card">
      <h2>Site-uri conectate</h2>
      <table><tr><th>Site</th><th>Feed</th><th>Pagina FB</th><th>Stare</th><th>Postări</th><th>Acțiuni</th></tr>${siteRows.join("")}</table>
      ${sites.length === 0 ? "<p>Niciun site. Adaugă unul cu butonul de sus.</p>" : ""}
    </div>
    <div class="card">
      <h2>Ultimele postări</h2>
      <table><tr><th>Data</th><th>Site</th><th>Articol</th><th>Facebook</th></tr>${postRows || "<tr><td colspan=4>Nimic încă.</td></tr>"}</table>
    </div>`));
});

// ---------- adăugare / editare site ----------

function siteForm(s = {}, isNew = true) {
  return `<form method="post" action="/admin/sites" class="card">
    <h2>${isNew ? "➕ Adaugă site" : `✏️ ${esc(s.name || s.slug)}`}</h2>
    <label>Slug (identificator, fără spații)</label>
    <input name="slug" value="${esc(s.slug || "")}" ${isNew ? "" : "readonly"} required pattern="[a-z0-9-]+">
    <label>Nume afișat</label>
    <input name="name" value="${esc(s.name || "")}" required>
    <label>Feed URL (RSS sau Atom)</label>
    <input name="feed_url" value="${esc(s.feed_url || "")}" required type="url">
    <label>Facebook Page ID</label>
    <input name="fb_page_id" value="${esc(s.fb_page_id || "")}">
    <label>Facebook Page Access Token ${isNew ? "" : "<small>(gol = păstrează tokenul actual)</small>"}</label>
    <input name="fb_access_token" value="" placeholder="${s.fb_access_token ? "•••• setat — scrie doar dacă vrei să-l schimbi" : "EAAB..."}">
    <label>Cheie OpenAI dedicată <small>(opțional; gol = folosește cheia globală${isNew ? "" : ", sau păstrează cheia actuală"})</small></label>
    <input name="openai_api_key" value="" placeholder="${s.openai_api_key ? "•••• setată" : "sk-... (opțional)"}">
    <button type="submit">💾 Salvează</button> <a class="btn" href="/admin">Renunță</a>
    ${isNew ? "" : `</form><form method="post" action="/admin/sites/${esc(s.slug)}/delete" onsubmit="return confirm('Ștergi site-ul ${esc(s.slug)}? Istoricul postărilor rămâne (dedup intact).')" class="card"><button class="danger">🗑️ Șterge site-ul</button>`}
  </form>`;
}

admin.get("/sites/new", (req, res) => res.send(page("Adaugă site", siteForm({}, true))));

admin.get("/sites/:slug/edit", async (req, res) => {
  const s = await getSite(req.params.slug);
  if (!s) return res.redirect("/admin");
  res.send(page("Editează", siteForm(s, false)));
});

admin.post("/sites", async (req, res) => {
  const { slug, name, feed_url, fb_page_id, fb_access_token, openai_api_key } = req.body;
  if (!/^[a-z0-9-]+$/.test(slug || "")) return res.status(400).send(page("Eroare", `<p class="err">Slug invalid.</p><a class="btn" href="/admin">Înapoi</a>`));
  await upsertSite({ slug, name, feed_url, fb_page_id: (fb_page_id || "").trim(), fb_access_token: (fb_access_token || "").trim(), openai_api_key: (openai_api_key || "").trim() });
  res.redirect("/admin");
});

admin.post("/sites/:slug/toggle", async (req, res) => {
  const s = await getSite(req.params.slug);
  if (s) await setSiteActive(s.slug, !s.active);
  res.redirect("/admin");
});

admin.post("/sites/:slug/delete", async (req, res) => {
  await deleteSite(req.params.slug);
  res.redirect("/admin");
});

// ---------- conectare pagini prin Facebook Login (OAuth) ----------
// Fluxul „fără dureri de cap": buton → login Facebook → bifezi paginile →
// panoul primește singur Page ID + token de pagină (long-lived) și le salvează.

const pendingPages = new Map(); // key -> { pages, exp } (ține 10 min)

// Toate permisiunile de pagină utile: postări + poze/albume, Reels și
// Stories (pages_manage_posts le acoperă pe toate trei), comentarii ca
// pagină (pages_manage_engagement), citirea comentariilor vizitatorilor
// (pages_read_user_content), metadate, statistici (read_insights) și
// paginile deținute prin Business Manager (business_management).
const FB_SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
  "pages_manage_engagement",
  "pages_read_user_content",
  "pages_manage_metadata",
  "read_insights",
  "business_management",
].join(",");

function fbConfigured() {
  return !!(process.env.FB_APP_ID && process.env.FB_APP_SECRET);
}

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return process.env.APP_BASE_URL || `${proto}://${host}`;
}

function oauthState() {
  return crypto.createHmac("sha256", process.env.CRON_SECRET || "no-secret").update("fb-oauth").digest("hex").slice(0, 32);
}

admin.get("/fb/connect", (req, res) => {
  if (!fbConfigured()) {
    return res.send(page("Conectare Facebook", `<div class="card"><h2>🔗 Conectare cu Facebook</h2>
      <p>Ca butonul să meargă, setează în Railway două variabile din aplicația ta Facebook
      (<b>developers.facebook.com</b> → aplicația ta → App settings → Basic):</p>
      <pre>FB_APP_ID=App ID-ul aplicației
FB_APP_SECRET=App Secret (apasă Show lângă el)</pre>
      <p>Și în aplicația Facebook → <b>Facebook Login</b> (sau Facebook Login for Business) → <b>Settings</b> →
      la <b>Valid OAuth Redirect URIs</b> adaugă:</p>
      <pre>${esc(baseUrl(req))}/admin/fb/callback</pre>
      <a class="btn" href="/admin">Înapoi</a></div>`));
  }
  const redirect = `${baseUrl(req)}/admin/fb/callback`;
  const url =
    `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(process.env.FB_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}&state=${oauthState()}` +
    `&scope=${encodeURIComponent(FB_SCOPES)}`;
  res.redirect(url);
});

admin.get("/fb/callback", async (req, res) => {
  const back = `<a class="btn" href="/admin">Înapoi</a>`;
  try {
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);
    if (req.query.state !== oauthState()) throw new Error("state invalid — reia conectarea din panou");
    const redirect = `${baseUrl(req)}/admin/fb/callback`;

    // cod → user token
    const r1 = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${encodeURIComponent(process.env.FB_APP_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirect)}&client_secret=${encodeURIComponent(process.env.FB_APP_SECRET)}` +
      `&code=${encodeURIComponent(req.query.code || "")}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const t1 = await r1.json();
    if (!t1.access_token) throw new Error(`schimb cod→token: ${JSON.stringify(t1.error || t1)}`);

    // user token → long-lived (tokenurile de pagină derivate nu mai expiră)
    const r2 = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(process.env.FB_APP_ID)}&client_secret=${encodeURIComponent(process.env.FB_APP_SECRET)}` +
      `&fb_exchange_token=${encodeURIComponent(t1.access_token)}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const t2 = await r2.json();
    const userToken = t2.access_token || t1.access_token;

    // paginile pe care ești admin
    const r3 = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(userToken)}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const d3 = await r3.json();
    const pages = d3.data || [];
    if (pages.length === 0) {
      return res.send(page("Conectare Facebook", `<div class="card"><h2>🔗 Conectare cu Facebook</h2>
        <p class="err">Login reușit, dar nicio pagină primită. La pasul de login trebuie BIFATE paginile —
        reia conectarea și bifează paginile când te întreabă.</p>
        <p><small>Dacă nu te mai întreabă de pagini: Facebook → Settings → Business integrations → șterge aplicația → reia.</small></p>
        <a class="btn" href="/admin/fb/connect">🔁 Reia conectarea</a> ${back}</div>`));
    }

    for (const [k, v] of pendingPages) if (v.exp < Date.now()) pendingPages.delete(k);
    const key = crypto.randomBytes(8).toString("hex");
    pendingPages.set(key, { pages, exp: Date.now() + 10 * 60 * 1000 });

    const sites = await getSites();
    const options = sites.map((s) => `<option value="${esc(s.slug)}">${esc(s.name)}</option>`).join("");
    const rows = pages.map((p, i) => `<tr>
      <td><b>${esc(p.name)}</b><br><small>ID ${esc(p.id)}</small></td>
      <td><form method="post" action="/admin/fb/assign">
        <input type="hidden" name="key" value="${key}"><input type="hidden" name="idx" value="${i}">
        <select name="slug">${options}</select> <button>💾 Leagă de site</button>
      </form></td>
    </tr>`).join("");
    res.send(page("Alege paginile", `<div class="card"><h2>✅ Facebook conectat — alege unde merge fiecare pagină</h2>
      <p>Pentru fiecare pagină, alege site-ul de care se leagă și apasă „Leagă de site". Tokenurile se salvează automat.</p>
      <table><tr><th>Pagina Facebook</th><th>Se leagă de</th></tr>${rows}</table>${back}</div>`));
  } catch (e) {
    res.send(page("Conectare Facebook", `<div class="card"><h2>🔗 Conectare cu Facebook</h2>
      <p class="err">Eroare: ${esc(e.message)}</p><a class="btn" href="/admin/fb/connect">🔁 Reîncearcă</a> ${back}</div>`));
  }
});

admin.post("/fb/assign", async (req, res) => {
  const entry = pendingPages.get(req.body.key);
  const p = entry?.pages?.[parseInt(req.body.idx, 10)];
  const s = await getSite(req.body.slug);
  if (!entry || entry.exp < Date.now() || !p || !s) {
    return res.send(page("Eroare", `<div class="card"><p class="err">Sesiunea de conectare a expirat — reia din panou.</p>
      <a class="btn" href="/admin/fb/connect">🔁 Reia conectarea</a></div>`));
  }
  await pool.query(
    `UPDATE sites SET fb_page_id = $2, fb_access_token = $3, updated_at = NOW() WHERE slug = $1`,
    [s.slug, p.id, p.access_token]
  );
  res.redirect("/admin");
});

// ---------- verificare token (Graph API) ----------

admin.post("/sites/:slug/check", async (req, res) => {
  const s = await getSite(req.params.slug);
  if (!s) return res.redirect("/admin");
  if (!s.fb_page_id || !s.fb_access_token) {
    return res.send(page("Verificare token", `<div class="card"><h2>🔎 ${esc(s.name)}</h2>
      <p class="err">Page ID sau token lipsă — completează-le întâi.</p><a class="btn" href="/admin">Înapoi</a></div>`));
  }
  let body;
  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(s.fb_page_id)}?fields=id,name&access_token=${encodeURIComponent(s.fb_access_token)}`,
      { signal: AbortSignal.timeout(15000), cache: "no-store" }
    );
    const data = await r.json();
    body = data.error
      ? `<p class="err">❌ Token INVALID: ${esc(data.error.message || JSON.stringify(data.error))}</p>
         <p><small>Dacă zice „session invalidated / changed password" → regenerează tokenul de pagină din Graph API Explorer.</small></p>`
      : `<p>✅ Token valid pentru pagina <b>${esc(data.name)}</b> (ID ${esc(data.id)}).</p>`;
  } catch (e) {
    body = `<p class="err">Eroare de rețea: ${esc(e.message)}</p>`;
  }
  res.send(page("Verificare token", `<div class="card"><h2>🔎 ${esc(s.name)}</h2>${body}<a class="btn" href="/admin">Înapoi</a></div>`));
});

// ---------- dry-run și postare manuală ----------

admin.post("/sites/:slug/dry-run", async (req, res) => {
  const result = await runSocialPost({ siteSlug: req.params.slug, dry: true });
  const r = result.results?.[0] || result;
  const would = (r.wouldPost || []).map((w) => `
    <div class="post">
      <h3>${esc(w.title)}</h3>
      <p><a href="${esc(w.link)}" target="_blank">${esc(w.link)}</a></p>
      <pre>${esc(w.caption)}</pre>
      <p><b>${w.gallery.length} poze:</b></p>
      <div class="thumbs">${w.gallery.map((g) => `<a href="${esc(g)}" target="_blank"><img src="${esc(g)}" loading="lazy"></a>`).join("")}</div>
    </div>`).join("");
  res.send(page("Dry-run", `<div class="card">
    <h2>🧪 Dry-run — nimic nu a fost postat</h2>
    ${r.skipped ? `<p>Sărit: ${esc(String(r.skipped))}</p>` : ""}
    ${r.error ? `<p class="err">${esc(String(r.error))}</p>` : ""}
    ${would || (!r.skipped && !r.error ? "<p>Niciun articol nou de postat.</p>" : "")}
    <a class="btn" href="/admin">Înapoi</a></div>`));
});

admin.post("/sites/:slug/run-now", async (req, res) => {
  const result = await runSocialPost({ siteSlug: req.params.slug, force: true });
  const r = result.results?.[0] || result;
  let body;
  if (r.posted) {
    const c = r.posted.comment === "ok"
      ? `<p>💬 Linkul articolului a fost pus în primul comentariu.</p>`
      : `<p class="err">⚠️ Postarea a mers, dar comentariul cu linkul a EȘUAT: ${esc(String(r.posted.comment || "").slice(0, 200))}</p>
         <p><small>De obicei lipsește permisiunea <b>pages_manage_engagement</b> — apasă „🔗 Conectează pagini cu Facebook" din dashboard și reconectează pagina (tokenul nou vine cu permisiunea corectă).</small></p>`;
    body = `<p>✅ Postat: <b>${esc(r.posted.title)}</b> (${r.posted.photos} poze)</p>${c}
      <p><a href="https://www.facebook.com/${esc(r.posted.fbPostId)}" target="_blank">Vezi postarea pe Facebook →</a></p>`;
  } else if (r.skipped) {
    body = `<p>Sărit: ${esc(String(r.skipped))}</p>`;
  } else if (r.error) {
    body = `<p class="err">Eroare: ${esc(String(r.error))}</p><p><small>Articolul intră în carantină ${r.quarantinedMinutes || 20} min, apoi se reîncearcă automat.</small></p>`;
  } else {
    body = `<p>Niciun articol nou de postat.</p>`;
  }
  res.send(page("Postare", `<div class="card"><h2>🚀 Rezultat</h2>${body}<a class="btn" href="/admin">Înapoi</a></div>`));
});

// ---------- helpers ----------

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDate(d) {
  return new Intl.DateTimeFormat("ro-RO", {
    dateStyle: "short", timeStyle: "short", timeZone: "Europe/Bucharest",
  }).format(new Date(d));
}

function page(title, body) {
  return `<!doctype html><html lang="ro"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — Social Bot</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; background: #f2f4f7; color: #1a202c; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 16px; }
  .topbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
  h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 0; }
  .card { background: #fff; border-radius: 10px; padding: 16px; margin: 14px 0; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  label { display: block; margin: 10px 0 4px; font-weight: 600; font-size: 14px; }
  input { width: 100%; padding: 9px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px; }
  button, .btn { display: inline-block; margin-top: 10px; padding: 8px 14px; border: 0; border-radius: 6px;
    background: #2b6cb0; color: #fff; font-size: 13px; cursor: pointer; text-decoration: none; }
  button.warn { background: #c05621; } button.danger { background: #c53030; }
  .actions form { display: inline; } .actions button, .actions .btn { margin: 2px; padding: 5px 9px; font-size: 12px; }
  .err { color: #c53030; font-weight: 600; }
  pre { background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; white-space: pre-wrap; font-family: inherit; }
  .thumbs { display: flex; flex-wrap: wrap; gap: 6px; }
  .thumbs img { width: 110px; height: 80px; object-fit: cover; border-radius: 6px; border: 1px solid #e2e8f0; }
  .post { border-top: 2px solid #e2e8f0; margin-top: 14px; padding-top: 10px; }
  small { color: #4a5568; }
</style></head><body><div class="wrap">${body}</div></body></html>`;
}
