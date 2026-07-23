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

admin.get("/", async (req, res) => {
  const sites = await getSites();
  const { rows: lastPosts } = await pool.query(
    `SELECT p.page_id, p.item_url, p.fb_post_id, p.posted_at, s.name AS site_name
     FROM external_fb_posts p
     LEFT JOIN sites s ON s.fb_page_id = p.page_id
     WHERE p.fb_post_id IS NOT NULL
     ORDER BY p.posted_at DESC LIMIT 20`
  );

  const siteRows = await Promise.all(sites.map(async (s) => {
    const { rows } = await pool.query(
      `SELECT MAX(posted_at) AS last, COUNT(*)::int AS n
       FROM external_fb_posts WHERE page_id = $1 AND fb_post_id IS NOT NULL`,
      [s.fb_page_id || "-"]
    );
    const configured = s.fb_page_id && s.fb_access_token;
    return `<tr>
      <td><b>${esc(s.name)}</b><br><small>${esc(s.slug)}</small></td>
      <td><small>${esc(s.feed_url)}</small></td>
      <td>${configured ? `✅ ${esc(s.fb_page_id)}` : `⚠️ neconfigurat`}</td>
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
      <span><a class="btn" href="/admin/sites/new">➕ Adaugă site</a> <a class="btn" href="/admin/logout">Ieși</a></span></div>
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
    body = `<p>✅ Postat: <b>${esc(r.posted.title)}</b> (${r.posted.photos} poze)</p>
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
