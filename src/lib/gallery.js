import { decodeEntities } from "./entities.js";

const IMG_BLACKLIST = /logo|avatar|icon|emoji|gravatar|pixel|badge|banner-|widget|sprite|placeholder|blank\.|spacer|zodiac|-flag\.|favicon|netopia|trafic-ro|google-news|\.svg(\?|$)/i;
const IMG_EXT = /\.(jpe?g|png|webp|gif)(\?|$)/i;

// Extrage galeria articolului. REGULA DE AUR: mai bine mai puține poze decât
// o poză străină (reclamă, alt articol, logo).
//
//   SURSE DE ÎNCREDERE (aparțin sigur articolului, orice domeniu):
//     1. <media:content> din feed
//     2. <img>-urile din content:encoded / summary (feed)
//     3. og:image de pe pagina articolului
//     4. imaginile din JSON-LD (schema.org NewsArticle → image/thumbnailUrl;
//        NU author.image / logo)
//
//   SURSE DE PE PAGINĂ (doar poze de pe domeniul site-ului):
//     5. containerele articolului (identificate explicit după clasă; se
//        extrag cu numărare de adâncime, ca div-urile de reclame injectate
//        în corp să nu taie parcurgerea)
//     6. containerele de galerie (galerie/gallery/swiper/lightbox etc.),
//        doar după titlul <h1>
//     7. linkurile <a data-gallery=...> (lightbox-ul galeriilor)
//     - NICIODATĂ fallback pe toată pagina.
// Returnează { images, text }: pozele articolului + textul lui real (din
// JSON-LD articleBody sau din containerul articolului) — textul alimentează
// captionul AI, ca să nu halucineze pe rezumate sărace din feed.
export async function extractGallery(articleUrl, feedContentHtml, mediaUrl = "") {
  const urls = [];
  let articleText = "";
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
    // dimensiuni mici în URL (ex: -150x150.jpg sau 728x90) → thumbnail/reclamă
    const dim = /(?:-|_|\/)(\d{2,4})x(\d{2,4})[.-]/i.exec(url);
    if (dim && (parseInt(dim[1], 10) < 400 || parseInt(dim[2], 10) < 250)) return;
    // variantele grid-/large- ale aceleiași poze sunt thumbnails de listing
    if (/\/(?:grid|thumb|small)-[^/]+$/i.test(url)) return;
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
  };

  // 1-2) sursele de încredere din feed
  if (mediaUrl) pushTrusted(mediaUrl);
  collectFromHtml(feedContentHtml, pushTrusted);

  // 3-7) pagina articolului
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

      // 3) og:image — poza oficială a articolului
      const og = /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i.exec(html)
        || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i.exec(html);
      if (og) pushTrusted(og[1]);

      // 4) JSON-LD: imaginile declarate ale articolului (nu author/logo)
      //    + textul integral al articolului (articleBody)
      const ld = jsonLdArticleData(html);
      for (const img of ld.images) pushTrusted(img);
      if (ld.body) articleText = ld.body;

      // 5) containerele articolului (toate aparițiile, extrase balansat)
      const reBody = /<(?:div|section|article)[^>]+(?:itemprop=["']articleBody["']|class=["'][^"']*(?:entry-content|post-content|article-content|article-body|td-post-content|single-content|story-body|post-body|content-article|article-context)[^"']*["'])[^>]*>|<(?:div|section)[^>]+class=["'](?:[^"']*\s)?content(?:\s[^"']*)?["'][^>]*>|<article[\s>]/gi;
      let b;
      let containers = 0;
      while ((b = reBody.exec(html)) !== null && containers < 8) {
        const slice = sliceBalanced(html, b.index);
        collectFromHtml(slice, pushPage);
        // fallback pentru text: cel mai lung container de articol găsit
        if (!articleText) {
          const t = stripToText(slice);
          if (t.length > 200) articleText = t;
        }
        containers++;
      }

      // 6) containerele de galerie, doar după titlul articolului
      const h1At = html.search(/<h1[\s>]/i);
      const reGal = /<(?:div|ul|section|figure)[^>]+(?:class|id)=["'][^"']*(?:galerie|gallery|image-gallery|photoswipe|lightgallery|fotorama|swiper)[^"']*["'][^>]*>/gi;
      let g;
      let galleries = 0;
      while ((g = reGal.exec(html)) !== null && galleries < 8) {
        if (h1At === -1 || g.index > h1At) {
          collectFromHtml(sliceBalanced(html, g.index), pushPage);
          galleries++;
        }
      }

      // 7) linkurile de lightbox ale galeriei (<a data-gallery=... href=...>)
      const reLb = /<a[^>]+data-gallery=[^>]*>/gi;
      let lb;
      while ((lb = reLb.exec(html)) !== null) {
        const href = /href=["']([^"']+)["']/i.exec(lb[0]);
        if (href && IMG_EXT.test(href[1])) pushPage(href[1]);
      }
      // FĂRĂ fallback pe toată pagina.
    }
  } catch {
    /* rămânem cu ce avem din feed */
  }

  return {
    images: dedupeSizeVariants(urls).slice(0, 10), // limita album FB
    text: articleText,
  };
}

function stripToText(html) {
  return decodeEntities(
    (html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

// Extrage elementul de la openIdx cu tot conținutul, numărând adâncimea
// tagurilor de același tip — regex-ul non-greedy s-ar opri la primul
// </div>, care poate fi al unei reclame injectate în corpul articolului.
function sliceBalanced(html, openIdx) {
  const t = /^<([a-z]+)/i.exec(html.slice(openIdx, openIdx + 20));
  if (!t) return "";
  const tag = t[1].toLowerCase();
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "gi");
  re.lastIndex = openIdx;
  let depth = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[0][1] === "/") {
      depth--;
      if (depth <= 0) return html.slice(openIdx, m.index + m[0].length);
    } else {
      depth++;
    }
    if (m.index - openIdx > 500000) break; // limită de siguranță
  }
  return html.slice(openIdx, openIdx + 200000);
}

// Din blocurile JSON-LD schema.org, DOAR de la obiectele de tip Article/
// NewsArticle: imaginile (image, thumbnailUrl — nu author.image, nu logo)
// și textul integral (articleBody).
function jsonLdArticleData(html) {
  const out = { images: [], body: "" };
  const reLd = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = reLd.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const stack = [data];
      while (stack.length) {
        const node = stack.pop();
        if (Array.isArray(node)) {
          stack.push(...node);
        } else if (node && typeof node === "object") {
          const type = String(node["@type"] || "");
          if (/Article/i.test(type)) {
            for (const val of [node.image, node.thumbnailUrl]) {
              for (const v of Array.isArray(val) ? val : [val]) {
                if (typeof v === "string") out.images.push(v);
                else if (v && typeof v === "object" && typeof v.url === "string") out.images.push(v.url);
              }
            }
            if (typeof node.articleBody === "string" && node.articleBody.length > out.body.length) {
              out.body = node.articleBody.replace(/\s+/g, " ").trim();
            }
          }
          for (const k of ["@graph", "mainEntity", "itemListElement"]) {
            if (node[k]) stack.push(node[k]);
          }
        }
      }
    } catch { /* JSON invalid → ignorăm blocul */ }
  }
  return out;
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
