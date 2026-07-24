import { pool, acquireLock, releaseLock } from "./db.js";
import { getSites } from "./sites.js";
import { fetchFeedItems } from "./lib/rss.js";
import { extractGallery } from "./lib/gallery.js";
import { aiCaption, fallbackCaption } from "./lib/caption.js";
import { postToPage, postPhotoToPage, postAlbumToPage, commentOnPost } from "./lib/fb.js";

const LOCK_NAME = "social-post";
// max 1 postare / N min / pagină (THROTTLE_MINUTES în env pentru alt ritm)
const THROTTLE_MINUTES = parseInt(process.env.THROTTLE_MINUTES || "15", 10);
const QUARANTINE_MINUTES = 20; // anti ghost-post: fără retry 20 min după orice tentativă
const DRY_RUN_MAX_ITEMS = 5;
// doar articole proaspete: mai vechi de atât (ore) nu se postează niciodată
const MAX_ARTICLE_AGE_HOURS = parseInt(process.env.MAX_ARTICLE_AGE_HOURS || "24", 10);

function isBusinessHoursRomania() {
  const h = parseInt(
    new Intl.DateTimeFormat("ro-RO", {
      hour: "numeric",
      hour12: false,
      timeZone: "Europe/Bucharest",
    }).format(new Date()),
    10
  );
  return h >= 6 && h < 22;
}

export async function runSocialPost({ siteSlug = null, force = false, dry = false } = {}) {
  // dry/force pot rula și în afara orelor 06-22 (pentru testare)
  if (!isBusinessHoursRomania() && !force && !dry) {
    return { skipped: "outside-business-hours" };
  }

  const gotLock = await acquireLock(LOCK_NAME);
  if (!gotLock) return { skipped: "locked" };

  try {
    const all = await getSites({ activeOnly: !siteSlug });
    const sites = siteSlug ? all.filter((s) => s.slug === siteSlug) : all;
    if (sites.length === 0) return { error: siteSlug ? `Site necunoscut: ${siteSlug}` : "niciun site activ" };

    const results = [];
    for (const site of sites) {
      results.push(await processSite(site, { force, dry }));
    }
    return { dry, results };
  } finally {
    await releaseLock(LOCK_NAME);
  }
}

async function processSite(site, { force, dry }) {
  const out = { site: site.slug };
  const pageId = site.fb_page_id;
  const token = site.fb_access_token;
  if (!pageId || !token) {
    return { ...out, skipped: "pagina FB neconfigurată (Page ID / token lipsă — setează-le în /admin)" };
  }

  // Carantina expirată: claim-uri fără fb_post_id mai vechi de 20 min → se pot reîncerca.
  await pool.query(
    `DELETE FROM external_fb_posts
     WHERE page_id = $1 AND fb_post_id IS NULL
       AND posted_at < NOW() - make_interval(mins => $2)`,
    [pageId, QUARANTINE_MINUTES]
  );

  // Throttle per pagină (force=1 sare peste; dry nu postează, deci nu contează)
  if (!force && !dry) {
    const t = await pool.query(
      `SELECT 1 FROM external_fb_posts
       WHERE page_id = $1 AND fb_post_id IS NOT NULL AND fb_post_id <> 'baseline'
         AND posted_at > NOW() - make_interval(mins => $2)
       LIMIT 1`,
      [pageId, THROTTLE_MINUTES]
    );
    if (t.rowCount > 0) return { ...out, skipped: "throttled" };
  }

  let items;
  try {
    items = await fetchFeedItems(site.feed_url);
  } catch (e) {
    return { ...out, error: `feed: ${e.message}` };
  }
  out.feedItems = items.length;

  // PRIMA ACTIVARE pe pagina asta: tot ce există deja în feed se marchează ca
  // „văzut" FĂRĂ să se posteze — de aici încolo se postează doar articolele
  // care apar NOI în feed. (Nu rulează la dry-run, ca să poți testa liniștit.)
  if (!dry) {
    const base = await pool.query(
      `SELECT 1 FROM external_fb_posts WHERE page_id = $1 AND item_url = '__baseline__'`,
      [pageId]
    );
    if (base.rowCount === 0) {
      for (const item of items) {
        await pool.query(
          `INSERT INTO external_fb_posts (page_id, item_url, fb_post_id)
           VALUES ($1, $2, 'baseline') ON CONFLICT (page_id, item_url) DO NOTHING`,
          [pageId, item.link]
        );
      }
      await pool.query(
        `INSERT INTO external_fb_posts (page_id, item_url, fb_post_id)
         VALUES ($1, '__baseline__', 'baseline') ON CONFLICT (page_id, item_url) DO NOTHING`,
        [pageId]
      );
      return {
        ...out,
        baselined: items.length,
        note: "prima activare: articolele existente au fost marcate ca văzute, fără postare — de acum se postează doar ce apare NOU în feed",
      };
    }
  }

  const dryReport = [];
  for (const item of items) {
    // doar articole din ziua curentă (max 24h; MAX_ARTICLE_AGE_HOURS în env)
    if (item.publishedAt && Date.now() - item.publishedAt.getTime() > MAX_ARTICLE_AGE_HOURS * 3600 * 1000) {
      continue;
    }
    // CLAIM ATOMIC înainte de orice: doar rularea care câștigă INSERT-ul postează.
    const claim = await pool.query(
      `INSERT INTO external_fb_posts (page_id, item_url, fb_post_id)
       VALUES ($1, $2, NULL)
       ON CONFLICT (page_id, item_url) DO NOTHING
       RETURNING item_url`,
      [pageId, item.link]
    );
    if (claim.rowCount === 0) continue; // deja postat sau revendicat/în carantină

    const gallery = await extractGallery(item.link, item.contentEncoded, item.mediaUrl);
    const caption =
      (await aiCaption(site, item.title, item.contentEncoded || item.description)) ||
      fallbackCaption(item.title);

    if (dry) {
      // DRY-RUN: raportează ce AR posta și eliberează claim-ul.
      dryReport.push({ title: item.title, link: item.link, caption, gallery });
      await pool.query(
        `DELETE FROM external_fb_posts WHERE page_id = $1 AND item_url = $2 AND fb_post_id IS NULL`,
        [pageId, item.link]
      );
      if (dryReport.length >= DRY_RUN_MAX_ITEMS) break;
      continue;
    }

    try {
      let fbPostId;
      if (gallery.length >= 2) {
        const r = await postAlbumToPage(pageId, token, gallery, caption);
        fbPostId = r.post_id;
      } else if (gallery.length === 1) {
        const r = await postPhotoToPage(pageId, token, gallery[0], caption);
        fbPostId = r.post_id;
      } else {
        const r = await postToPage(pageId, token, caption, item.link);
        fbPostId = r.id;
      }

      // linkul articolului în PRIMUL COMENTARIU — bug-urile aici nu mai sunt
      // tăcute: postarea rămâne, dar raportăm de ce n-a apărut comentariul
      let commentStatus = "ok";
      try {
        await commentOnPost(fbPostId, token, `📖 Citește articolul: ${item.link}`);
      } catch (e) {
        commentStatus = e.message;
        console.error(`comentariu eșuat pe ${fbPostId}:`, e.message);
      }

      await pool.query(
        `UPDATE external_fb_posts SET fb_post_id = $3, posted_at = NOW()
         WHERE page_id = $1 AND item_url = $2`,
        [pageId, item.link, fbPostId]
      );

      return { ...out, posted: { title: item.title, link: item.link, fbPostId, photos: gallery.length, comment: commentStatus } };
    } catch (e) {
      // NU ștergem claim-ul imediat (anti ghost-post): rămâne în carantină 20 min,
      // apoi cleanup-ul de la începutul rulării îl eliberează pentru retry.
      return { ...out, error: `post: ${e.message}`, item: item.link, quarantinedMinutes: QUARANTINE_MINUTES };
    }
  }

  if (dry) return { ...out, wouldPost: dryReport };
  return { ...out, posted: null, note: "niciun articol nou" };
}
