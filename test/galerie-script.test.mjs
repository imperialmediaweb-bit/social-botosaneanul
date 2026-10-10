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

globalThis.fetch = async (url) => {
  if (String(url) === "https://site.test/articol") return new Response(PAGE, { status: 200 });
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

console.log(`\nREZULTAT: ${pass} ✔ / ${fail} ✘`);
process.exit(fail ? 1 : 0);
