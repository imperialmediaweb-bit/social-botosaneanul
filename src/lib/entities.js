// OBLIGATORIU pe orice URL/text extras din XML: `&amp;` corupe URL-urile
// semnate de CDN → 403 la upload pe Facebook.
export function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, "„")
    .replace(/&#8221;/g, "”")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&nbsp;/g, " ")
    // entități numerice generice (&#038; = &, &#x26; = & etc.) — feed-urile WP
    // le folosesc în URL-uri; fără decodare, URL-urile semnate de CDN se corup
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 10)); } catch { return _; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 16)); } catch { return _; }
    });
}

export function extractTag(block, tag) {
  // whitespace permis între tag și CDATA (feed-urile Atom pun newline acolo)
  const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i").exec(block);
  if (cdata) return decodeEntities(cdata[1].trim());
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!plain) return "";
  // dacă fallback-ul a prins totuși un CDATA nedetectat, scoate-i învelișul
  const inner = plain[1].trim().replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1").trim();
  return decodeEntities(inner);
}

export function stripHtml(html) {
  return decodeEntities(
    (html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}
