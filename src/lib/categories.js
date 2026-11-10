// Filtru de INCLUDERE pe categorii. Feed-ul botosaneanul.ro nu spune categoria
// articolului, iar linkurile nu o conțin. Paginile de categorie au însă lista
// curată a articolelor în JSON-LD (CollectionPage → ItemList → itemListElement),
// fără meniul și bara laterală. De acolo luăm linkurile permise.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export function normalizeUrl(u) {
  try {
    const x = new URL(String(u).trim());
    return `${x.hostname.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(u).trim().toLowerCase();
  }
}

export function parseIncludePages(text) {
  return String(text || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

// Linkurile articolelor din ItemList-urile JSON-LD ale unei pagini.
export function itemListUrls(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== "object") return;
      if (v["@type"] === "ItemList" && Array.isArray(v.itemListElement)) {
        for (const el of v.itemListElement) {
          const u = el?.url || el?.item?.url || el?.item?.["@id"] || (typeof el?.item === "string" ? el.item : "");
          if (u) out.push(u);
        }
      }
      for (const k of Object.keys(v)) walk(v[k]);
    };
    walk(data);
  }
  return out;
}

// Setul de linkuri permise din toate paginile de categorie. O pagină care nu
// se încarcă nu blochează restul; dacă NICIUNA nu se încarcă, întoarce eroare
// (mai bine nu postăm nimic decât să postăm tot).
export async function fetchAllowedLinks(pages) {
  const allowed = new Set();
  const errors = [];
  let ok = 0;
  await Promise.all(
    pages.map(async (p) => {
      try {
        // site-ul închide uneori conexiunea: o a doua încercare înainte să renunțăm
        let html;
        for (let i = 0; i < 2 && html === undefined; i++) {
          try {
            const res = await fetch(p, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(25000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            html = await res.text();
          } catch (e) {
            if (i === 1) throw e;
          }
        }
        const urls = itemListUrls(html);
        if (!urls.length) throw new Error("nicio listă de articole (JSON-LD) pe pagină");
        urls.forEach((u) => allowed.add(normalizeUrl(u)));
        ok++;
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
      }
    })
  );
  return { allowed, ok, errors };
}
