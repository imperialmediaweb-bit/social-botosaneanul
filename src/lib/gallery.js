import { decodeEntities } from "./entities.js";

const IMG_BLACKLIST = /logo|avatar|icon|emoji|gravatar|pixel|badge|banner-|widget|\.svg(\?|$)/i;
const IMG_EXT = /\.(jpe?g|png|webp|gif)(\?|$)/i;

// Extrage TOATĂ galeria articolului. Surse, în ordine:
//   1. pozele din content:encoded (feed)
//   2. pagina articolului: og:image + <img> din corp (entry-content la WP)
//   3. containerele de galerie/slider de ORIUNDE în pagină (la Botoșăneanul
//      galeria e randată cu JS după articol, nu în entry-content)
//   4. URL-uri de poze din JSON-ul <script>-urilor (galeriile JS își țin
//      pozele acolo, cu slash-uri escapate: https:\/\/...jpg)
// Acoperă lazy-loading (data-src/data-lazy-src/srcset) și link-urile către
// varianta full-size (<a href="...jpg"> pe thumbnail). La final, variantele
// aceleiași poze (-800x600 vs. full) se deduplică, păstrând-o pe cea mare.
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

  // Din srcset alegem candidatul cu lățimea cea mai mare (varianta full).
  const pushSrcset = (srcset) => {
    let best = null;
    let bestW = 0;
    for (const part of (srcset || "").split(",")) {
      const m = /^\s*(\S+)\s+(\d+)w\s*$/.exec(part);
      if (m && parseInt(m[2], 10) > bestW) {
        bestW = parseInt(m[2], 10);
        best = m[1];
      }
    }
    if (best) push(best);
  };

  const collectFromHtml = (html) => {
    if (!html) return;
    let m;
    // <img>: întâi atributele de lazy-load (au varianta reală/mare), apoi src
    const reImg = /<img[^>]+>/gi;
    while ((m = reImg.exec(html)) !== null) {
      const tag = m[0];
      const attr = (name) => {
        const a = new RegExp(`${name}=["']([^"']+)["']`, "i").exec(tag);
        return a ? a[1] : "";
      };
      const ss = attr("data-srcset") || attr("srcset");
      if (ss) pushSrcset(ss);
      push(
        attr("data-orig-file") || attr("data-full-url") || attr("data-large-file") ||
        attr("data-lazy-src") || attr("data-src") || attr("src")
      );
    }
    // galerii: <a href="...jpg"> în jurul thumbnail-urilor → poza full-size
    const reA = /<a[^>]+href=["']([^"']+)["']/gi;
    while ((m = reA.exec(html)) !== null) {
      if (IMG_EXT.test(m[1])) push(m[1]);
    }
  };

  // 1) pozele din content:encoded (feed)
  collectFromHtml(feedContentHtml);

  // 2-4) pagina articolului
  try {
    const res = await fetch(articleUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const html = await res.text();
      const og = /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i.exec(html);
      if (og) push(og[1]);

      // corpul articolului (WP: entry-content etc.)
      const body = /<(?:div|section|article)[^>]+class=["'][^"']*(?:entry-content|post-content|article-content|td-post-content)[^"']*["'][\s\S]*?<\/(?:div|section|article)>/i.exec(html);
      collectFromHtml(body ? body[0] : html);

      // containerele de galerie/slider de ORIUNDE în pagină (galeria JS de după articol)
      const reGal = /<(?:div|ul|section|figure)[^>]+(?:class|id)=["'][^"']*(?:gallery|galerie|slider|swiper|carousel|owl-|lightgallery|fotorama|photoswipe)[^"']*["'][\s\S]*?<\/(?:div|ul|section|figure)>/gi;
      let g;
      while ((g = reGal.exec(html)) !== null) collectFromHtml(g[0]);

      // JSON din <script>-uri: https:\/\/...jpg (galeriile JS își țin pozele aici)
      const reScript = /<script[^>]*>([\s\S]*?)<\/script>/gi;
      let s;
      while ((s = reScript.exec(html)) !== null) {
        const reJsonImg = /https?:\\?\/\\?\/[^"'\s\\]+(?:\\\/[^"'\s\\]+)*\.(?:jpe?g|png|webp)/gi;
        let j;
        while ((j = reJsonImg.exec(s[1])) !== null) push(j[0].replace(/\\\//g, "/"));
      }
    }
  } catch {
    /* rămânem cu ce avem din feed */
  }

  return dedupeSizeVariants(urls).slice(0, 10); // limita album FB
}

// Aceeași poză apare des în mai multe mărimi (foto-800x600.jpg + foto.jpg).
// Grupăm după numele de bază (fără sufixul -WxH) și păstrăm varianta cea mai
// mare: originalul dacă există, altfel redimensionarea cu lățimea maximă.
function dedupeSizeVariants(urls) {
  const groups = new Map();
  for (const url of urls) {
    const m = /^(.*?)(?:-(\d{2,4})x(\d{2,4}))?(\.(?:jpe?g|png|webp|gif))((?:\?.*)?)$/i.exec(url);
    if (!m) {
      if (!groups.has(url)) groups.set(url, { url, width: Infinity });
      continue;
    }
    const key = (m[1] + m[4]).toLowerCase();
    const width = m[2] ? parseInt(m[2], 10) : Infinity; // fără sufix = original
    const existing = groups.get(key);
    if (!existing || width > existing.width) groups.set(key, { url, width });
  }
  return [...groups.values()].map((g) => g.url);
}
