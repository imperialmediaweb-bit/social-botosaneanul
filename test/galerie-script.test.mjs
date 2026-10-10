// Regresie YesComment.ro (10.10.2026): tema WordPress pune în <script> texte
// de traducere care conțin "<article>". Detectorul de containere le lua drept
// începutul articolului și trăgea în galerie toate pozele din bara laterală.
// Nu are nevoie de Postgres: rețeaua e simulată.

const PAGE = `<!DOCTYPE html><html><head>
<script>var t={"The <article> element should represent a self-contained portion":["..."]};</script>
<style>.x{content:"<article>"}</style>
</head><body>
<!-- <article><img src="https://site.test/uploads/din-comentariu.jpg"></article> -->
<article class="post"><h1>Titlu</h1>
  <div class="entry-content"><p>${"Textul real al articolului. ".repeat(20)}</p>
    <img src="https://site.test/uploads/poza-articol.jpg"></div>
</article>
<aside id="secondary"><img src="https://site.test/uploads/reclama-laterala.jpg"></aside>
</body></html>`;

// articol preluat fără poze: poza vine din og:image-ul articolului original
const PRELUAT = (href, text) => `<html><body><h1>T</h1><div class="entry-content">
  <p>${"Text preluat. ".repeat(30)}</p><a href="${href}">${text}</a></div></body></html>`;
const PAGES = {
  "https://site.test/articol": PAGE,
  "https://site.test/preluat-hotnews": PRELUAT("https://hotnews.ro/stire-1", "Citește mai mult pe Hotnews.ro"),
  "https://site.test/preluat-gnews": PRELUAT("https://news.google.com/rss/articles/XYZ", "Sursa &amp; Foto Credit- news.google.com"),
  "https://site.test/link-oarecare": PRELUAT("https://hotnews.ro/alta-stire", "un link oarecare din text"),
  "https://hotnews.ro/stire-1": `<meta property="og:image" content="https://hotnews.ro/uploads/poza-originala.jpg">`,
  "https://hotnews.ro/alta-stire": `<meta property="og:image" content="https://hotnews.ro/uploads/alta-poza.jpg">`,
  "https://news.google.com/rss/articles/XYZ": `<meta property="og:image" content="https://lh3.googleusercontent.com/sigla-google-news">`,
};
globalThis.fetch = async (url) => {
  if (PAGES[String(url)] !== undefined) return new Response(PAGES[String(url)], { status: 200 });
  throw new Error("fetch neașteptat în test: " + url);
};

const { extractGallery } = await import("../src/lib/gallery.js");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name} ${extra}`); }
};

console.log("— Galeria ignoră <article> din scripturi/stiluri/comentarii —");
const g = await extractGallery("https://site.test/articol", "", "");
check("poza articolului e găsită", g.images.includes("https://site.test/uploads/poza-articol.jpg"), JSON.stringify(g.images));
check("poza din bara laterală NU intră", !g.images.some((u) => u.includes("reclama-laterala")), JSON.stringify(g.images));
check("poza dintr-un comentariu HTML NU intră", !g.images.some((u) => u.includes("din-comentariu")), JSON.stringify(g.images));
check("textul articolului nu include bara laterală", g.text.length > 200 && g.text.length < 1000, `len=${g.text.length}`);

console.log("— Articol preluat fără poze: poza din articolul original —");
const h = await extractGallery("https://site.test/preluat-hotnews", "", "");
check("ia og:image-ul articolului original (linkul „Citește mai mult pe…”)",
  h.images.length === 1 && h.images[0] === "https://hotnews.ro/uploads/poza-originala.jpg", JSON.stringify(h.images));
const gn = await extractGallery("https://site.test/preluat-gnews", "", "");
check("NU ia sigla când sursa e un agregator (Google News)", gn.images.length === 0, JSON.stringify(gn.images));
const lo = await extractGallery("https://site.test/link-oarecare", "", "");
check("NU urmează linkuri obișnuite din text (doar cele de atribuire)", lo.images.length === 0, JSON.stringify(lo.images));

console.log(`\nREZULTAT: ${pass} ✔ / ${fail} ✘`);
process.exit(fail ? 1 : 0);
