import { decodeEntities } from "./entities.js";

const IMG_BLACKLIST = /logo|avatar|icon|emoji|gravatar|pixel|badge|banner-|widget|\.svg(\?|$)/i;

// Extrage TOATĂ galeria articolului: pozele din content:encoded (feed) +
// og:image și pozele din corpul articolului (pagina propriu-zisă).
export async function extractGallery(articleUrl, feedContentHtml) {
  const urls = [];
  const push = (u) => {
    const url = decodeEntities((u || "").trim());
    if (!/^https?:\/\/.+\.[a-z]/i.test(url)) return;
    if (IMG_BLACKLIST.test(url)) return;
    // dimensiuni mici în URL (ex: -150x150.jpg) → thumbnail, skip
    const dim = /-(\d{2,4})x(\d{2,4})\.(jpe?g|png|webp)/i.exec(url);
    if (dim && (parseInt(dim[1], 10) < 400 || parseInt(dim[2], 10) < 250)) return;
    if (!urls.includes(url)) urls.push(url);
  };

  // 1) pozele din content:encoded (feed)
  let m;
  const re1 = /<img[^>]+src=["']([^"']+)["']/gi;
  while ((m = re1.exec(feedContentHtml || "")) !== null) push(m[1]);

  // 2) pagina articolului: og:image + pozele din corp (entry-content la WP)
  try {
    const res = await fetch(articleUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SocialBot/1.0)" },
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const html = await res.text();
      const og = /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i.exec(html);
      if (og) push(og[1]);
      // doar zona articolului dacă o găsim (WP: entry-content / article)
      const body = /<(?:div|section|article)[^>]+class=["'][^"']*(?:entry-content|post-content|article-content|td-post-content)[^"']*["'][\s\S]*?<\/(?:div|section|article)>/i.exec(html);
      const scope = body ? body[0] : html;
      const re2 = /<img[^>]+(?:data-src|src)=["']([^"']+)["']/gi;
      while ((m = re2.exec(scope)) !== null) push(m[1]);
    }
  } catch {
    /* rămânem cu ce avem din feed */
  }

  return urls.slice(0, 10); // limita album FB
}
