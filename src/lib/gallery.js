import { decodeEntities } from "./entities.js";

const IMG_BLACKLIST = /logo|avatar|icon|emoji|gravatar|pixel|badge|banner-|widget|sprite|placeholder|blank\.|spacer|\.svg(\?|$)/i;
const IMG_EXT = /\.(jpe?g|png|webp|gif)(\?|$)/i;

// Extrage galeria articolului. REGULA DE AUR: mai bine mai puține poze decât
// o poză străină (reclamă, alt articol, logo). De aceea:
//
//   SURSE DE ÎNCREDERE (aparțin sigur articolului, orice domeniu):
//     1. <media:content> din feed
//     2. <img>-urile din content:encoded / summary (feed)
//     3. og:image de pe pagina articolului
//
//   SURSE DE PE PAGINĂ (condiționate):
//     4. pozele din CONTAINERUL ARTICOLULUI (dacă îl identificăm sigur)
//     5. containerele explicit de GALERIE (clase gen galerie/gallery), doar
//        după titlul <h1> al articolului
//     - ambele DOAR cu poze de pe domeniul site-ului (nu Google, nu ads)
//     - NICIODATĂ fallback pe toată pagina: dacă nu găsim containerul,
//       rămânem cu sursele de încredere.
export async function extractGallery(articleUrl, feedContentHtml, mediaUrl = "") {
  const urls = [];
  let siteDomain = "";
  try {
    const parts = new URL(articleUrl).hostname.split(".");
    siteDomain = parts.slice(-2).join("."); // botosaneanul.ro
  } catch { /* URL invalid → doar sursele din feed */ }

  const accept = (u, { requireSameDomain }) => {
    const url = decodeEntities((u || "").trim());
    if (!/^https?:\/\/.+\.[a-z]/i.test(url)) return;
    if (IMG_BLACKLIST.test(url)) return;
    if (requireSameDomain) {
      try {
        const host = new URL(url).hostname;
        if (!siteDomain || !(host === siteDomain || host.endsWith(`.${siteDomain}`))) return;
      } catch { return; }
    }
    // dimensiuni mici în URL (ex: -150x150.jpg) → thumbnail, skip
    const dim = /-(\d{2,4})x(\d{2,4})\.(jpe?g|png|webp)/i.exec(url);
    if (dim && (parseInt(dim[1], 10) < 400 || parseInt(dim[2], 10) < 250)) return;
    if (!urls.includes(url)) urls.push(url);
  };
  const pushTrusted = (u) => accept(u, { requireSameDomain: false });
  const pushPage = (u) => accept(u, { requireSameDomain: true });

  const pushSrcset = (srcset, push) => {
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

  const collectFromHtml = (html, push) => {
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
      if (ss) pushSrcset(ss, push);
      push(
        attr("data-orig-file") || attr("data-full-url") || attr("data-large-file") ||
        attr("data-lazy-src") || attr("data-src") || attr("src")
      );
    }
    // <a href="...jpg"> pe thumbnail → poza full-size
    const reA = /<a[^>]+href=["']([^"']+)["']/gi;
    while ((m = reA.exec(html)) !== null) {
      if (IMG_EXT.test(m[1])) push(m[1]);
    }
    // URL-uri de poze din JSON-ul <script>-urilor DIN INTERIORUL zonei date
    // (galeriile JS își țin pozele acolo, cu slash-uri escapate)
    const reScript = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let s;
    while ((s = reScript.exec(html)) !== null) {
      const reJsonImg = /https?:\\?\/\\?\/[^"'\s\\]+(?:\\\/[^"'\s\\]+)*\.(?:jpe?g|png|webp)/gi;
      let j;
      while ((j = reJsonImg.exec(s[1])) !== null) push(j[0].replace(/\\\//g, "/"));
    }
  };

  // 1-2) sursele de încredere din feed
  if (mediaUrl) pushTrusted(mediaUrl);
  collectFromHtml(feedContentHtml, pushTrusted);

  // 3-5) pagina articolului
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

      // 3) og:image — poza oficială a articolului (de încredere)
      const og = /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i.exec(html)
        || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i.exec(html);
      if (og) pushTrusted(og[1]);

      // 4) containerul articolului — DOAR dacă îl identificăm explicit
      const bodyMatch =
        /<[a-z]+[^>]+itemprop=["']articleBody["'][\s\S]*?<\/(?:div|section|article)>/i.exec(html) ||
        /<(?:div|section|article)[^>]+(?:class|id)=["'][^"']*(?:entry-content|post-content|article-content|article-body|articleBody|td-post-content|single-content|story-body|post-body|content-article)[^"']*["'][\s\S]*?<\/(?:div|section|article)>/i.exec(html) ||
        /<article[\s>][\s\S]*?<\/article>/i.exec(html);
      if (bodyMatch) collectFromHtml(bodyMatch[0], pushPage);

      // 5) containerele explicit de GALERIE, doar după titlul articolului
      //    (cuvinte specifice de galerie foto — NU slider/carousel, alea sunt
      //    de obicei „ultimele știri" cu poze din ALTE articole)
      const h1At = html.search(/<h1[\s>]/i);
      const reGal = /<(?:div|ul|section|figure)[^>]+(?:class|id)=["'][^"']*(?:galerie|gallery|photoswipe|lightgallery|fotorama)[^"']*["'][\s\S]*?<\/(?:div|ul|section|figure)>/gi;
      let g;
      while ((g = reGal.exec(html)) !== null) {
        if (h1At === -1 || g.index > h1At) collectFromHtml(g[0], pushPage);
      }
      // FĂRĂ fallback pe toată pagina — dacă n-am găsit nimic, rămânem cu
      // sursele de încredere (mai bine 1 poză corectă decât 10 dubioase).
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
