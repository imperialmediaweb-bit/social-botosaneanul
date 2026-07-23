# social-botosaneanul

Serviciu standalone care citește feed-ul RSS al site-ului și postează automat
articolele noi pe pagina de Facebook:

- **toată galeria de poze** din articol (album FB, max 10 poze),
- caption AI scurt (gpt-4o-mini, română cu diacritice, fără întrebare finală),
- „📌 Detalii complete în primul comentariu 👇" în caption,
- **linkul articolului în primul comentariu** (nu în postare — reach mai bun),
- dedup persistent + claim atomic + lacăt global + carantină anti ghost-post.

## Rulare

```
npm install
npm start
```

Necesită Postgres (`DATABASE_URL`) — schema se creează singură la pornire.
Vezi `.env.example` pentru toate variabilele.

## Endpoint cron

```
GET /api/cron/social-post?key=CRON_SECRET[&site=botosaneanul][&force=1][&dry=1]
```

- fără `site` → procesează toate site-urile pe rând
- `dry=1` → **nu postează nimic**; returnează JSON cu ce AR posta (titlu,
  caption generat, galerie, link) — max 5 articole per site. Obligatoriu de
  rulat înainte de live. `dry`/`force` merg și în afara orelor 06–22.
- `force=1` → sare peste throttle (nu și peste dedup)

Declanșare externă (Railway nu are cron intern de încredere): cron-job.org
sau UptimeRobot la **15 minute** pe URL-ul de mai sus.

## Reguli de postare

- doar 06:00–22:00 Europe/Bucharest
- max 1 postare / 15 min / pagină (throttle)
- max 1 articol nou postat per rulare per pagină
- după orice tentativă eșuată pe un articol → carantină 20 min înainte de
  retry (protecție ghost-post: Graph API poate reuși chiar dacă răspunsul
  HTTP pică)

## Deploy pe Railway

1. New Project → Deploy from GitHub repo (start command: `npm start`)
2. Adaugă un Postgres în proiect; `DATABASE_URL` = referință la el
3. Setează env-urile din `.env.example` (CRON_SECRET, OPENAI_API_KEY,
   BOTOSANEANUL_FB_PAGE_ID, BOTOSANEANUL_FB_ACCESS_TOKEN)
4. Test: `/api/cron/social-post?key=...&dry=1` → verifică JSON-ul
5. Live + cron extern la 15 min

### Token de pagină Facebook

Graph API Explorer → user token cu `pages_manage_posts,pages_read_engagement`
→ `GET /me/accounts` → `access_token`-ul paginii (ideal long-lived: schimbă
întâi user token-ul în long-lived). Atenție: token-urile mor la schimbarea
parolei contului — se regenerează, nu e bug.

## Urmează (după legarea la Railway)

- Panou de admin pentru conectarea paginilor FB (site-uri în tabelul `sites`
  din DB în loc de env vars).
