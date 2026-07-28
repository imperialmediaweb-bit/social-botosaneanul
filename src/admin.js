import express from "express";
import crypto from "crypto";
import { pool } from "./db.js";
import { getSites, getSite, upsertSite, setSiteActive, deleteSite } from "./sites.js";
import { runSocialPost } from "./cron.js";

export const admin = express.Router();

// Express 4 nu prinde erorile din handlerele async — o eroare de DB ar deveni
// unhandledRejection și ar omorî procesul. Împachetăm automat toate rutele.
for (const method of ["get", "post"]) {
  const orig = admin[method].bind(admin);
  admin[method] = (path, ...handlers) =>
    orig(path, ...handlers.map((h) => (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)));
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ---------- autentificare (parolă din ADMIN_PASSWORD, cookie semnat) ----------

// Două niveluri de acces:
//  - admin (ADMIN_PASSWORD): totul
//  - client (CLIENT_PASSWORD, opțional): vede dashboardul, poate pune pauză,
//    testa și posta manual — dar NU poate umbla la setări, tokenuri, site-uri
function cookieToken(role) {
  const pass = role === "client" ? process.env.CLIENT_PASSWORD : process.env.ADMIN_PASSWORD;
  return crypto
    .createHmac("sha256", process.env.CRON_SECRET || "no-secret")
    .update(`${role}:${pass || ""}`)
    .digest("hex");
}

function getRole(req) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => {
      const i = c.indexOf("=");
      return i === -1 ? [c.trim(), ""] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
    })
  );
  if (process.env.ADMIN_PASSWORD && safeEqual(cookies.adm, cookieToken("admin"))) return "admin";
  if (process.env.CLIENT_PASSWORD && safeEqual(cookies.adm, cookieToken("client"))) return "client";
  return null;
}

function adminOnly(req, res, next) {
  if (req.role !== "admin") {
    return res.status(403).send(page("Acces restricționat", `<div class="card">
      <div class="alert warn">Secțiunea asta e disponibilă doar administratorului sistemului.</div>
      <a class="btn" href="/admin">← Înapoi</a></div>`, { role: req.role }));
  }
  next();
}

// anti brute-force pe login: max 10 încercări eșuate / 15 min / IP
const loginAttempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const a = loginAttempts.get(ip);
  if (a && a.resetAt < now) loginAttempts.delete(ip);
  return (loginAttempts.get(ip)?.n || 0) >= 10;
}
function recordFailedLogin(ip) {
  const a = loginAttempts.get(ip) || { n: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  a.n++;
  loginAttempts.set(ip, a);
}
function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
}

admin.use(express.urlencoded({ extended: false }));

admin.use((req, res, next) => {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(503).send(page("Admin dezactivat", `<div class="card"><h2>Panou dezactivat</h2>
      <p>Setează variabila de mediu <code>ADMIN_PASSWORD</code> în Railway ca să activezi panoul.</p></div>`));
  }
  if (req.path === "/login") return next();
  req.role = getRole(req);
  if (!req.role) return res.redirect("/admin/login");
  next();
});

function loginPage(error = "") {
  return page("Autentificare", `
    <div class="login-wrap">
      <form method="post" action="/admin/login" class="card login-card">
        <div class="login-logo-wrap"><img src="https://www.botosaneanul.ro/assets/uploads/media-uploader/logo1684429147.png" alt="Botoșăneanul" class="login-logo-img" onerror="this.outerHTML='<div class=login-logo>🕴️</div>'"></div>
        <h1 class="login-title">Social Botoșăneanul</h1>
        <p class="login-sub">Panoul de administrare a postărilor</p>
        ${error ? `<div class="alert err">${error}</div>` : ""}
        <label>Parola</label>
        <input type="password" name="password" autofocus autocomplete="current-password">
        <button type="submit" class="btn primary w100">Intră în panou</button>
      </form>
    </div>`, { bare: true });
}

admin.get("/login", (req, res) => res.send(loginPage()));

admin.post("/login", (req, res) => {
  const ip = clientIp(req);
  if (tooManyAttempts(ip)) {
    return res.status(429).send(loginPage("Prea multe încercări. Așteaptă 15 minute."));
  }
  const role =
    safeEqual(req.body.password, process.env.ADMIN_PASSWORD) ? "admin" :
    process.env.CLIENT_PASSWORD && safeEqual(req.body.password, process.env.CLIENT_PASSWORD) ? "client" :
    null;
  if (role) {
    loginAttempts.delete(ip);
    res.setHeader("Set-Cookie", `adm=${cookieToken(role)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return res.redirect("/admin");
  }
  recordFailedLogin(ip);
  res.send(loginPage("Parolă greșită."));
});

admin.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "adm=; Path=/; Max-Age=0");
  res.redirect("/admin/login");
});

// ---------- conectare pagini prin Facebook Login (OAuth) ----------

const pendingPages = new Map(); // key -> { pages, exp } (ține 10 min)

// Toate permisiunile de pagină utile: postări + poze/albume, Reels și
// Stories (pages_manage_posts le acoperă), comentarii ca pagină, citirea
// comentariilor, metadate, statistici și paginile din Business Manager.
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

admin.get("/fb/connect", adminOnly, (req, res) => {
  if (!fbConfigured()) {
    return res.send(page("Conectare Facebook", `<div class="card"><h2>🔗 Conectare cu Facebook</h2>
      <p>Ca butonul să meargă, setează în Railway două variabile din aplicația ta Facebook
      (<b>developers.facebook.com</b> → aplicația ta → App settings → Basic):</p>
      <pre>FB_APP_ID=App ID-ul aplicației
FB_APP_SECRET=App Secret (apasă Show lângă el)</pre>
      <p>Și în aplicația Facebook → <b>Facebook Login</b> → <b>Settings</b> →
      la <b>Valid OAuth Redirect URIs</b> adaugă:</p>
      <pre>${esc(baseUrl(req))}/admin/fb/callback</pre>
      <a class="btn" href="/admin">← Înapoi</a></div>`));
  }
  const redirect = `${baseUrl(req)}/admin/fb/callback`;
  const url =
    `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(process.env.FB_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}&state=${oauthState()}` +
    `&scope=${encodeURIComponent(FB_SCOPES)}`;
  res.redirect(url);
});

admin.get("/fb/callback", adminOnly, async (req, res) => {
  const back = `<a class="btn" href="/admin">← Înapoi</a>`;
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
        <div class="alert err">Login reușit, dar nicio pagină primită. La pasul de login trebuie BIFATE paginile —
        reia conectarea și bifează paginile când te întreabă.</div>
        <p class="muted">Dacă nu te mai întreabă de pagini: Facebook → Settings → Business integrations → șterge aplicația → reia.</p>
        <a class="btn primary" href="/admin/fb/connect">🔁 Reia conectarea</a> ${back}</div>`));
    }

    for (const [k, v] of pendingPages) if (v.exp < Date.now()) pendingPages.delete(k);
    const key = crypto.randomBytes(8).toString("hex");
    pendingPages.set(key, { pages, exp: Date.now() + 10 * 60 * 1000 });

    const sites = await getSites();
    const options = sites.map((s) => `<option value="${esc(s.slug)}">${esc(s.name)}</option>`).join("");
    const rows = pages.map((p, i) => `<tr>
      <td><b>${esc(p.name)}</b><br><span class="muted">ID ${esc(p.id)}</span></td>
      <td><form method="post" action="/admin/fb/assign" class="inline-form">
        <input type="hidden" name="key" value="${key}"><input type="hidden" name="idx" value="${i}">
        <select name="slug">${options}</select> <button class="btn primary sm">💾 Leagă de site</button>
      </form></td>
    </tr>`).join("");
    res.send(page("Alege paginile", `<div class="card"><h2>✅ Facebook conectat — leagă paginile de site-uri</h2>
      <p class="muted">Pentru fiecare pagină, alege site-ul de care se leagă. Tokenurile se salvează automat.</p>
      <table><tr><th>Pagina Facebook</th><th>Se leagă de</th></tr>${rows}</table>${back}</div>`));
  } catch (e) {
    res.send(page("Conectare Facebook", `<div class="card"><h2>🔗 Conectare cu Facebook</h2>
      <div class="alert err">Eroare: ${esc(e.message)}</div>
      <a class="btn primary" href="/admin/fb/connect">🔁 Reîncearcă</a> ${back}</div>`));
  }
});

admin.post("/fb/assign", adminOnly, async (req, res) => {
  const entry = pendingPages.get(req.body.key);
  const p = entry?.pages?.[parseInt(req.body.idx, 10)];
  const s = await getSite(req.body.slug);
  if (!entry || entry.exp < Date.now() || !p || !s) {
    return res.send(page("Eroare", `<div class="card"><div class="alert err">Sesiunea de conectare a expirat — reia din panou.</div>
      <a class="btn primary" href="/admin/fb/connect">🔁 Reia conectarea</a></div>`));
  }
  await pool.query(
    `UPDATE sites SET fb_page_id = $2, fb_access_token = $3, updated_at = NOW() WHERE slug = $1`,
    [s.slug, p.id, p.access_token]
  );
  res.redirect("/admin");
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

// titlu lizibil din slug-ul URL-ului articolului
function prettyTitle(url) {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() || url;
    const t = seg.replace(/[-_]+/g, " ").trim();
    return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 95);
  } catch {
    return url.slice(0, 95);
  }
}

// reacții/comentarii/distribuiri pentru o postare, live din Graph API
async function postEngagement(fbPostId, token) {
  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(fbPostId)}` +
      `?fields=reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares` +
      `&access_token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(5000), cache: "no-store" }
    );
    const d = await r.json();
    if (d.error) return null;
    return {
      reactions: d.reactions?.summary?.total_count ?? 0,
      comments: d.comments?.summary?.total_count ?? 0,
      shares: d.shares?.count ?? 0,
    };
  } catch {
    return null;
  }
}

// prima pagină: DOAR cardurile site-urilor — click pe card → pagina site-ului
admin.get("/", async (req, res) => {
  const sites = await getSites();
  const statuses = await Promise.all(sites.map(tokenStatus));

  const siteCards = await Promise.all(sites.map(async (s, i) => {
    const { rows } = await pool.query(
      `SELECT MAX(posted_at) AS last, COUNT(*)::int AS n
       FROM external_fb_posts
       WHERE page_id = $1 AND fb_post_id IS NOT NULL AND fb_post_id NOT IN ('baseline', 'filtered')`,
      [s.fb_page_id || "-"]
    );
    const st = statuses[i];
    const tokenBadge =
      st.state === "ok" ? `<span class="badge ok">✓ Conectat</span>` :
      st.state === "invalid" ? `<span class="badge err">✕ Token mort</span>` :
      st.state === "unconfigured" ? `<span class="badge warn">⚠ Neconectat</span>` :
      `<span class="badge off">? offline</span>`;
    const stateBadge = s.active
      ? `<span class="badge ok"><span class="dot"></span> Activ</span>`
      : `<span class="badge off"><span class="dot gray"></span> Pe pauză</span>`;
    return `<a class="card site-card" href="/admin/sites/${esc(s.slug)}">
      <div class="site-head"><span class="site-name">${esc(s.name)}</span></div>
      <div class="site-badges">${stateBadge} ${tokenBadge}</div>
      <div class="site-meta">
        <span>📊 ${rows[0].n} postări</span>
        ${rows[0].last ? `<span>🕒 ultima: ${fmtDate(rows[0].last)}</span>` : ""}
      </div>
      <div class="site-open">Deschide panoul site-ului →</div>
    </a>`;
  }));

  res.send(page("Site-uri", `
    <div class="sites-grid">${siteCards.join("")}</div>
    ${sites.length === 0 ? `<div class="card empty">🌱 Niciun site încă. Adaugă unul cu butonul „Adaugă site" de sus.</div>` : ""}`, { role: req.role }));
});

// ---------- adăugare / editare site ----------

function siteForm(s = {}, isNew = true) {
  return `<div class="card form-card">
    <h2>${isNew ? "➕ Adaugă site" : `⚙️ Setări — ${esc(s.name || s.slug)}`}</h2>
    <form method="post" action="/admin/sites">
      <div class="form-grid">
        <div>
          <label>Slug <small>(identificator, fără spații)</small></label>
          <input name="slug" value="${esc(s.slug || "")}" ${isNew ? "" : "readonly"} required pattern="[a-z0-9-]+" placeholder="ex: botosaneanul">
        </div>
        <div>
          <label>Nume afișat</label>
          <input name="name" value="${esc(s.name || "")}" required placeholder="ex: Botoșăneanul">
        </div>
      </div>
      <label>Feed URL <small>(RSS sau Atom)</small></label>
      <input name="feed_url" value="${esc(s.feed_url || "")}" required type="url" placeholder="https://...">
      <div class="form-grid">
        <div>
          <label>Facebook Page ID</label>
          <input name="fb_page_id" value="${esc(s.fb_page_id || "")}" placeholder="ID-ul numeric al paginii">
        </div>
        <div>
          <label>Page Access Token ${isNew ? "" : "<small>(gol = păstrează tokenul actual)</small>"}</label>
          <input name="fb_access_token" value="" placeholder="${s.fb_access_token ? "•••• setat — scrie doar ca să-l schimbi" : "EAAB... (sau folosește Conectează cu Facebook)"}">
        </div>
      </div>
      <label>Cheie OpenAI dedicată <small>(opțional; gol = cheia globală${isNew ? "" : ", sau păstrează cheia actuală"})</small></label>
      <input name="openai_api_key" value="" placeholder="${s.openai_api_key ? "•••• setată" : "sk-... (opțional)"}">
      <label>Excludere articole <small>(cuvânt sau regex; articolele care îl conțin în titlu/text/sursă NU se postează — ex: <b>hotnews</b>)</small></label>
      <input name="exclude_pattern" value="${esc(s.exclude_pattern || "")}" placeholder="ex: hotnews">
      <label>Stilul postărilor — instrucțiuni pentru AI <small>(scrie liber cum vrei să sune postările; ex: „mai lungi, ton serios de presă, fără emoji" sau „scurte și energice, cu emoji"). Regulile de siguranță (fără fapte inventate, fără nume) rămân mereu active.</small></label>
      <textarea name="style_prompt" rows="3" placeholder="ex: Ton jurnalistic sobru. Două propoziții. Fără emoji la subiectele grave.">${esc(s.style_prompt || "")}</textarea>
      <div class="form-actions">
        <button type="submit" class="btn primary">💾 Salvează</button>
        <a class="btn" href="/admin">Renunță</a>
      </div>
    </form>
  </div>
  ${isNew ? "" : `<div class="card danger-zone">
    <h2>🗑️ Zonă periculoasă</h2>
    <p class="muted">Ștergerea scoate site-ul din panou. Istoricul postărilor rămâne (protecția anti-dublare e intactă).</p>
    <form method="post" action="/admin/sites/${esc(s.slug)}/delete" onsubmit="return confirm('Ștergi site-ul ${esc(s.slug)}?')">
      <button class="btn danger">Șterge site-ul</button>
    </form>
  </div>`}`;
}

admin.get("/sites/new", adminOnly, (req, res) => res.send(page("Adaugă site", siteForm({}, true))));

// pagina unui site: acțiunile, statisticile și istoricul LUI
admin.get("/sites/:slug", async (req, res) => {
  const s = await getSite(req.params.slug);
  if (!s) return res.redirect("/admin");
  const st = await tokenStatus(s);
  const pageId = s.fb_page_id || "-";

  const { rows: [stats] } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE posted_at > NOW() - INTERVAL '24 hours')::int AS last24,
       COUNT(*) FILTER (WHERE posted_at > NOW() - INTERVAL '7 days')::int AS last7,
       COUNT(*) FILTER (WHERE posted_at > NOW() - INTERVAL '30 days')::int AS last30,
       COUNT(*)::int AS total
     FROM external_fb_posts
     WHERE page_id = $1 AND fb_post_id IS NOT NULL AND fb_post_id NOT IN ('baseline', 'filtered')`,
    [pageId]
  );

  const { rows: lastPosts } = await pool.query(
    `SELECT item_url, fb_post_id, posted_at FROM external_fb_posts
     WHERE page_id = $1 AND fb_post_id IS NOT NULL AND fb_post_id NOT IN ('baseline', 'filtered')
     ORDER BY posted_at DESC LIMIT 20`,
    [pageId]
  );

  // performanța reală, live din Graph API (reacții/comentarii/distribuiri)
  const engagement = await Promise.all(
    lastPosts.map((p) => s.fb_access_token ? postEngagement(p.fb_post_id, s.fb_access_token) : null)
  );
  const engTotal = engagement.filter(Boolean).reduce(
    (a, e) => ({ r: a.r + e.reactions, c: a.c + e.comments, s: a.s + e.shares }),
    { r: 0, c: 0, s: 0 }
  );

  const tokenBadge =
    st.state === "ok" ? `<span class="badge ok">✓ Conectat: ${esc(st.pageName)}</span>` :
    st.state === "invalid" ? `<span class="badge err">✕ Token mort</span>` :
    st.state === "unconfigured" ? `<span class="badge warn">⚠ Neconectat</span>` :
    `<span class="badge off">? Graph API indisponibil</span>`;
  const stateBadge = s.active
    ? `<span class="badge ok"><span class="dot"></span> Activ</span>`
    : `<span class="badge off"><span class="dot gray"></span> Pe pauză</span>`;
  const tokenAlert = st.state === "invalid"
    ? `<div class="alert err">Tokenul paginii a murit: ${esc((st.message || "").slice(0, 120))}<br>
       <small>Apasă „Conectează cu Facebook" din bara de sus și releagă pagina — se rezolvă în 30 de secunde.</small></div>`
    : "";

  const postRows = lastPosts.map((p, i) => {
    const e = engagement[i];
    return `<tr>
    <td class="nowrap muted">${fmtDate(p.posted_at)}</td>
    <td><a href="${esc(p.item_url)}" target="_blank" class="post-link">${esc(prettyTitle(p.item_url))}</a></td>
    <td class="nowrap eng">${e ? `👍 ${e.reactions} &nbsp;💬 ${e.comments} &nbsp;↗ ${e.shares}` : `<span class="muted">–</span>`}</td>
    <td class="nowrap"><a class="btn sm" href="https://www.facebook.com/${esc(p.fb_post_id)}" target="_blank">Vezi pe FB ↗</a></td>
  </tr>`;
  }).join("");

  res.send(page(s.name, `
    <p style="margin-top:16px"><a class="btn sm" href="/admin">← Toate site-urile</a></p>
    <div class="card site">
      <div class="site-head">
        <span class="site-name">${esc(s.name)}</span>
        ${stateBadge} ${tokenBadge}
      </div>
      <div class="site-meta">
        <span title="Feed">📡 ${esc(s.feed_url)}</span>
        ${s.exclude_pattern ? `<span title="Filtru de excludere">🚫 exclude: <b>${esc(s.exclude_pattern)}</b></span>` : ""}
        ${(s.style_prompt || "").trim() ? `<span title="Stil personalizat">✍️ stil personalizat setat</span>` : ""}
      </div>
      ${tokenAlert}
      <div class="site-actions">
        <form method="post" action="/admin/sites/${esc(s.slug)}/dry-run"><button class="btn">🧪 Test fără postare</button></form>
        <form method="post" action="/admin/sites/${esc(s.slug)}/run-now" onsubmit="return confirm('Postează ACUM pe Facebook primul articol nepostat de la ${esc(s.name)}. Continui?')"><button class="btn warn">🚀 Postează acum</button></form>
        <span class="flex-spacer"></span>
        <a class="btn sm" href="/admin/sites/${esc(s.slug)}/style">✍️ Stil postări</a>
        ${req.role === "admin" ? `<a class="btn sm" href="/admin/sites/${esc(s.slug)}/edit">⚙️ Setări</a>` : ""}
        <form method="post" action="/admin/sites/${esc(s.slug)}/check"><button class="btn sm">🔍 Verifică token</button></form>
        <form method="post" action="/admin/sites/${esc(s.slug)}/toggle"><button class="btn sm">${s.active ? "⏸ Pune pe pauză" : "▶ Pornește"}</button></form>
      </div>
    </div>
    <div class="stats-row">
      <div class="stat"><div class="stat-n">${stats.last24}</div><div class="stat-l">postări în 24h</div></div>
      <div class="stat"><div class="stat-n">${stats.last7}</div><div class="stat-l">în ultimele 7 zile</div></div>
      <div class="stat"><div class="stat-n">${stats.last30}</div><div class="stat-l">în ultimele 30 de zile</div></div>
      <div class="stat"><div class="stat-n">${stats.total}</div><div class="stat-l">total postări</div></div>
      <div class="stat accent"><div class="stat-n">${engTotal.r + engTotal.c + engTotal.s}</div><div class="stat-l">interacțiuni la ultimele ${lastPosts.length} postări<br><small>👍 ${engTotal.r} · 💬 ${engTotal.c} · ↗ ${engTotal.s}</small></div></div>
    </div>
    <div class="card">
      <h2>🕘 Postările site-ului</h2>
      ${postRows
        ? `<div class="table-scroll"><table><tr><th>Data</th><th>Articol</th><th>Performanță</th><th></th></tr>${postRows}</table></div>`
        : `<div class="empty">Nicio postare încă. Primul articol nou publicat pe site va apărea aici automat. 🚀</div>`}
    </div>`, { role: req.role }));
});

admin.get("/sites/:slug/edit", adminOnly, async (req, res) => {
  const s = await getSite(req.params.slug);
  if (!s) return res.redirect("/admin");
  res.send(page("Setări", siteForm(s, false)));
});

admin.post("/sites", adminOnly, async (req, res) => {
  const { slug, name, feed_url, fb_page_id, fb_access_token, openai_api_key, exclude_pattern, style_prompt } = req.body;
  if (!/^[a-z0-9-]+$/.test(slug || "")) {
    return res.status(400).send(page("Eroare", `<div class="card"><div class="alert err">Slug invalid.</div><a class="btn" href="/admin">← Înapoi</a></div>`));
  }
  await upsertSite({
    slug, name, feed_url,
    fb_page_id: (fb_page_id || "").trim(),
    fb_access_token: (fb_access_token || "").trim(),
    openai_api_key: (openai_api_key || "").trim(),
    exclude_pattern: (exclude_pattern || "").trim(),
    style_prompt: (style_prompt || "").trim().slice(0, 1000),
  });
  res.redirect("/admin");
});

admin.post("/sites/:slug/toggle", async (req, res) => {
  const s = await getSite(req.params.slug);
  if (s) await setSiteActive(s.slug, !s.active);
  res.redirect(s ? `/admin/sites/${s.slug}` : "/admin");
});

admin.post("/sites/:slug/delete", adminOnly, async (req, res) => {
  await deleteSite(req.params.slug);
  res.redirect("/admin");
});

// ---------- stilul postărilor (accesibil și clientului) ----------

admin.get("/sites/:slug/style", async (req, res) => {
  const s = await getSite(req.params.slug);
  if (!s) return res.redirect("/admin");
  res.send(page("Stilul postărilor", `<div class="card form-card">
    <h2>✍️ Stilul postărilor — ${esc(s.name)}</h2>
    <p class="muted">Scrieți liber cum vreți să sune postările de Facebook, iar inteligența artificială va respecta indicațiile.
    Exemple: „mai lungi și detaliate", „ton serios de presă, fără emoji", „scurte și energice", „fără emoji la subiecte grave".</p>
    <form method="post" action="/admin/sites/${esc(s.slug)}/style">
      <label>Indicații de stil</label>
      <textarea name="style_prompt" rows="5" placeholder="ex: Ton jurnalistic sobru. Două propoziții. Fără emoji la subiectele grave.">${esc(s.style_prompt || "")}</textarea>
      <p class="muted">Regulile de siguranță rămân mereu active indiferent de indicații: postările nu inventează fapte, nu dau nume de persoane și nu dezvăluie tot conținutul articolului.</p>
      <div class="form-actions">
        <button type="submit" class="btn primary">💾 Salvează stilul</button>
        <a class="btn" href="/admin/sites/${esc(s.slug)}">Renunță</a>
      </div>
    </form>
  </div>`, { role: req.role }));
});

admin.post("/sites/:slug/style", async (req, res) => {
  const s = await getSite(req.params.slug);
  if (s) {
    await pool.query(
      `UPDATE sites SET style_prompt = $2, updated_at = NOW() WHERE slug = $1`,
      [s.slug, (req.body.style_prompt || "").trim().slice(0, 1000)]
    );
  }
  res.redirect(s ? `/admin/sites/${s.slug}` : "/admin");
});

// ---------- verificare token (Graph API) ----------

admin.post("/sites/:slug/check", async (req, res) => {
  const s = await getSite(req.params.slug);
  if (!s) return res.redirect("/admin");
  if (!s.fb_page_id || !s.fb_access_token) {
    return res.send(page("Verificare token", `<div class="card"><h2>🔍 ${esc(s.name)}</h2>
      <div class="alert err">Page ID sau token lipsă — conectează pagina întâi.</div><a class="btn" href="/admin/sites/${esc(s.slug)}">← Înapoi</a></div>`));
  }
  let body;
  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(s.fb_page_id)}?fields=id,name&access_token=${encodeURIComponent(s.fb_access_token)}`,
      { signal: AbortSignal.timeout(15000), cache: "no-store" }
    );
    const data = await r.json();
    body = data.error
      ? `<div class="alert err">✕ Token INVALID: ${esc(data.error.message || JSON.stringify(data.error))}</div>
         <p class="muted">Dacă zice „session invalidated / changed password" → apasă „Conectează cu Facebook" din dashboard și releagă pagina.</p>`
      : `<div class="alert ok">✓ Token valid pentru pagina <b>${esc(data.name)}</b> (ID ${esc(data.id)}).</div>`;
  } catch (e) {
    body = `<div class="alert err">Eroare de rețea: ${esc(e.message)}</div>`;
  }
  res.send(page("Verificare token", `<div class="card"><h2>🔍 ${esc(s.name)}</h2>${body}<a class="btn" href="/admin/sites/${esc(s.slug)}">← Înapoi</a></div>`));
});

// ---------- dry-run și postare manuală ----------

admin.post("/sites/:slug/dry-run", async (req, res) => {
  const result = await runSocialPost({ siteSlug: req.params.slug, dry: true });
  const r = result.results?.[0] || result;
  const would = (r.wouldPost || []).map((w) => `
    <div class="post">
      <h3>${esc(w.title)}</h3>
      <p><a href="${esc(w.link)}" target="_blank" class="post-link">${esc(w.link)}</a></p>
      <pre>${esc(w.caption)}</pre>
      <p><b>${w.gallery.length} ${w.gallery.length === 1 ? "poză" : "poze"}:</b></p>
      <div class="thumbs">${w.gallery.map((g) => `<a href="${esc(g)}" target="_blank"><img src="${esc(g)}" loading="lazy"></a>`).join("")}</div>
    </div>`).join("");
  res.send(page("Test fără postare", `<div class="card">
    <h2>🧪 Test — nimic nu a fost postat</h2>
    <p class="muted">Așa AR arăta următoarele postări (caption + poze), fără să fi publicat nimic.</p>
    ${r.skipped ? `<div class="alert warn">Sărit: ${esc(String(r.skipped))}</div>` : ""}
    ${r.error ? `<div class="alert err">${esc(String(r.error))}</div>` : ""}
    ${would || (!r.skipped && !r.error ? `<div class="empty">Niciun articol nou de postat. ✔</div>` : "")}
    <a class="btn" href="/admin/sites/${esc(req.params.slug)}">← Înapoi</a></div>`));
});

admin.post("/sites/:slug/run-now", async (req, res) => {
  const result = await runSocialPost({ siteSlug: req.params.slug, force: true });
  const r = result.results?.[0] || result;
  let body;
  if (r.posted) {
    const c = r.posted.comment === "ok"
      ? `<div class="alert ok">💬 Linkul articolului a fost pus în primul comentariu.</div>`
      : `<div class="alert err">⚠ Postarea a mers, dar comentariul cu linkul a EȘUAT: ${esc(String(r.posted.comment || "").slice(0, 200))}
         <br><small>De obicei lipsește permisiunea de comentarii — apasă „Conectează cu Facebook" și releagă pagina.</small></div>`;
    body = `<div class="alert ok">✓ Postat: <b>${esc(r.posted.title)}</b> (${r.posted.photos} poze)</div>${c}
      <a class="btn primary" href="https://www.facebook.com/${esc(r.posted.fbPostId)}" target="_blank">Vezi postarea pe Facebook ↗</a>`;
  } else if (r.skipped) {
    body = `<div class="alert warn">Sărit: ${esc(String(r.skipped))}</div>`;
  } else if (r.error) {
    body = `<div class="alert err">Eroare: ${esc(String(r.error))}
      <br><small>Articolul intră în carantină ${r.quarantinedMinutes || 20} min, apoi se reîncearcă automat.</small></div>`;
  } else {
    body = `<div class="empty">Niciun articol nou de postat. ✔</div>`;
  }
  res.send(page("Postare manuală", `<div class="card"><h2>🚀 Rezultat</h2>${body}<p></p><a class="btn" href="/admin/sites/${esc(req.params.slug)}">← Înapoi</a></div>`));
});

// ---------- helpers ----------

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDate(d) {
  return new Intl.DateTimeFormat("ro-RO", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Bucharest",
  }).format(new Date(d));
}

function page(title, body, { bare = false, role = "admin" } = {}) {
  const adminBtns = role === "admin"
    ? `<a class="btn ghost" href="/admin/fb/connect">🔗 Conectează cu Facebook</a>
       <a class="btn ghost" href="/admin/sites/new">➕ Adaugă site</a>`
    : "";
  const topbar = bare ? "" : `
  <header class="topbar"><div class="topbar-inner">
    <a href="/admin" class="logo"><img src="https://www.botosaneanul.ro/assets/uploads/media-uploader/logo1684429147.png" alt="Botoșăneanul" class="logo-img" onerror="this.style.display='none'"><span class="logo-name">· Social</span></a>
    <span class="flex-spacer"></span>
    ${adminBtns}
    <a class="btn ghost" href="/admin/logout">Ieși</a>
  </div></header>`;
  return `<!doctype html><html lang="ro"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — Social Botoșăneanul</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, Arial, sans-serif; background: #f2f4f8; color: #16181d; font-size: 15px; line-height: 1.5; }
  a { color: #2456e6; }
  code, pre { font-family: ui-monospace, Consolas, monospace; }
  pre { background: #f7f8fb; border: 1px solid #e6e9f0; border-radius: 10px; padding: 12px 14px; white-space: pre-wrap; font-size: 13.5px; margin: 8px 0; }
  .muted { color: #6b7280; font-size: 13.5px; }

  .topbar { position: sticky; top: 0; z-index: 10; background: linear-gradient(100deg, #16226e 0%, #2c3c9c 100%); box-shadow: 0 2px 12px rgba(22,34,110,.32); }
  .topbar-inner { max-width: 1080px; margin: 0 auto; padding: 12px 16px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .logo { color: #fff; font-size: 18px; text-decoration: none; letter-spacing: .2px; margin-right: 8px; display: inline-flex; align-items: center; gap: 8px; }
  .logo-name { font-family: "Playfair Display", Georgia, "Times New Roman", serif; font-weight: 700; }
  .logo-img { height: 34px; width: auto; display: block; }
  .flex-spacer { flex: 1; }

  .wrap { max-width: 1080px; margin: 0 auto; padding: 20px 16px 70px; }

  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 15px; border: 1px solid #d4d9e2; border-radius: 9px;
    background: #fff; color: #16181d; font-size: 13.5px; font-weight: 600; cursor: pointer; text-decoration: none; transition: all .15s; white-space: nowrap; }
  .btn:hover { border-color: #94a3b8; box-shadow: 0 2px 6px rgba(0,0,0,.08); transform: translateY(-1px); }
  .btn.primary { background: #2456e6; border-color: #2456e6; color: #fff; }
  .btn.primary:hover { background: #1d47c4; }
  .btn.warn { background: #c2570f; border-color: #c2570f; color: #fff; }
  .btn.warn:hover { background: #a84a0a; }
  .btn.danger { background: #dc2626; border-color: #dc2626; color: #fff; }
  .btn.ghost { background: rgba(255,255,255,.12); border-color: transparent; color: #fff; }
  .btn.ghost:hover { background: rgba(255,255,255,.22); box-shadow: none; }
  .btn.sm { padding: 6px 11px; font-size: 12.5px; }
  .btn.w100 { width: 100%; justify-content: center; margin-top: 16px; }

  .card { background: #fff; border: 1px solid #e6e9f0; border-radius: 14px; padding: 20px 22px; margin: 16px 0; box-shadow: 0 1px 3px rgba(16,24,40,.05); }
  h2 { font-size: 16px; margin-bottom: 12px; }
  h3 { font-size: 15px; margin-bottom: 6px; }

  .sites-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin: 16px 0; }
  .sites-grid .card { margin: 0; display: flex; flex-direction: column; }
  .site-card { text-decoration: none; color: inherit; transition: all .15s; }
  .site-card:hover { border-color: #2456e6; box-shadow: 0 4px 14px rgba(36,86,230,.15); transform: translateY(-2px); }
  .site-badges { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
  .site-open { color: #2456e6; font-weight: 700; font-size: 13px; margin-top: 12px; }
  .site-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .site-name { font-size: 18px; font-weight: 800; }
  .site-meta { display: flex; gap: 8px 18px; flex-wrap: wrap; color: #6b7280; font-size: 13px; margin-bottom: 4px; }
  .site-meta span { overflow-wrap: anywhere; }
  .site-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; border-top: 1px solid #eef0f4; padding-top: 14px; margin-top: auto; }
  .site .site-meta { margin-bottom: 12px; }
  .site-actions form { display: inline; }
  @media (max-width: 900px) { .sites-grid { grid-template-columns: 1fr; } }

  .badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 11px; border-radius: 999px; font-size: 12px; font-weight: 700; }
  .badge.ok { background: #e8f7ee; color: #14742f; }
  .badge.err { background: #fdecec; color: #b42318; }
  .badge.warn { background: #fff4e5; color: #9a5b13; }
  .badge.off { background: #eef0f4; color: #5b6472; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; display: inline-block; }
  .dot.gray { background: #9ca3af; }

  .alert { border-radius: 10px; padding: 12px 14px; margin: 10px 0; font-size: 13.5px; }
  .alert.err { background: #fdecec; color: #b42318; border: 1px solid #f7c8c4; }
  .alert.ok { background: #e8f7ee; color: #14742f; border: 1px solid #bfe8cd; }
  .alert.warn { background: #fff4e5; color: #9a5b13; border: 1px solid #f5ddb8; }

  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; color: #6b7280; font-size: 11.5px; text-transform: uppercase; letter-spacing: .5px; padding: 8px; border-bottom: 2px solid #eef0f4; }
  td { padding: 10px 8px; border-bottom: 1px solid #f1f3f7; vertical-align: middle; }
  tr:hover td { background: #f8fafc; }
  .nowrap { white-space: nowrap; }
  .post-link { color: #16181d; text-decoration: none; font-weight: 600; }
  .post-link:hover { color: #2456e6; }

  label { display: block; margin: 14px 0 6px; font-weight: 700; font-size: 13.5px; }
  label small { font-weight: 400; color: #6b7280; }
  input, select, textarea { width: 100%; padding: 10px 13px; border: 1.5px solid #d4d9e2; border-radius: 9px; font-size: 14px; background: #fff; font-family: inherit; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: #2456e6; box-shadow: 0 0 0 3px rgba(36,86,230,.13); }
  input[readonly] { background: #f2f4f8; color: #6b7280; }
  select { width: auto; padding: 8px 10px; }
  .inline-form { display: flex; gap: 8px; align-items: center; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
  .form-card { max-width: 720px; }
  .form-actions { display: flex; gap: 10px; margin-top: 20px; }
  .danger-zone { max-width: 720px; border-color: #f7c8c4; }

  .empty { color: #6b7280; text-align: center; padding: 26px 10px; font-size: 14px; }

  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 16px 0; }
  .stat { background: #fff; border: 1px solid #e6e9f0; border-radius: 14px; padding: 16px 18px; box-shadow: 0 1px 3px rgba(16,24,40,.05); }
  .stat-n { font-size: 28px; font-weight: 800; line-height: 1.1; }
  .stat-l { color: #6b7280; font-size: 12.5px; margin-top: 4px; }
  .stat.accent { background: linear-gradient(120deg, #16226e 0%, #2c3c9c 100%); border: 0; }
  .stat.accent .stat-n, .stat.accent .stat-l { color: #fff; }
  .stat.accent .stat-l small { color: rgba(255,255,255,.75); }
  .eng { font-size: 12.5px; }

  .post { border-top: 2px solid #eef0f4; margin-top: 18px; padding-top: 14px; }
  .thumbs { display: flex; flex-wrap: wrap; gap: 8px; }
  .thumbs img { width: 118px; height: 86px; object-fit: cover; border-radius: 9px; border: 1px solid #e6e9f0; transition: transform .15s; }
  .thumbs a:hover img { transform: scale(1.05); }

  .login-wrap { min-height: 92vh; display: flex; align-items: center; justify-content: center; }
  .login-card { width: 100%; max-width: 380px; text-align: center; padding: 34px 30px; }
  .login-logo { font-size: 44px; }
  .login-title { font-size: 22px; font-weight: 700; margin-top: 6px; font-family: "Playfair Display", Georgia, "Times New Roman", serif; }
  .login-card { border-top: 4px solid #16226e; }
  .login-logo-wrap { background: linear-gradient(100deg, #16226e 0%, #2c3c9c 100%); border-radius: 10px; padding: 14px 10px; margin-bottom: 14px; }
  .login-logo-img { max-width: 82%; height: auto; }
  .login-sub { color: #6b7280; font-size: 13.5px; margin-bottom: 10px; }
  .login-card label { text-align: left; }

  @media (max-width: 640px) {
    .form-grid { grid-template-columns: 1fr; }
    .site-actions .flex-spacer { display: none; }
    .topbar-inner { padding: 10px 12px; }
    .btn { padding: 8px 12px; }
    .card { padding: 16px; }
  }
</style></head><body>${topbar}<div class="wrap">${body}</div></body></html>`;
}
