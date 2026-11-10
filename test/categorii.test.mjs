// Filtrul „Doar categoriile": se iau linkurile DOAR din lista JSON-LD a
// paginii de categorie (nu din meniu / bara laterală), iar o pagină care
// nu se încarcă nu blochează restul.
import assert from "node:assert/strict";
import { itemListUrls, normalizeUrl, parseIncludePages, fetchAllowedLinks } from "../src/lib/categories.js";

const pagina = (urls) => `<html><body>
<a href="https://www.botosaneanul.ro/articol-din-bara-laterala-care-nu-trebuie-inclus">x</a>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"CollectionPage","mainEntity":{"@type":"ItemList",
"itemListElement":${JSON.stringify(urls.map((u, i) => ({ "@type": "ListItem", position: i + 1, url: u })))}}}]}</script>
<script type="application/ld+json">{ stricat </script></body></html>`;

assert.deepEqual(itemListUrls(pagina(["https://www.botosaneanul.ro/a1", "https://www.botosaneanul.ro/a2"])), [
  "https://www.botosaneanul.ro/a1",
  "https://www.botosaneanul.ro/a2",
]);
assert.equal(normalizeUrl("https://WWW.Botosaneanul.ro/a1/"), normalizeUrl("https://botosaneanul.ro/a1"));
assert.deepEqual(parseIncludePages("https://x.ro/a\n  https://x.ro/b , gunoi\n"), ["https://x.ro/a", "https://x.ro/b"]);

let apeluri = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("/stirea-zilei")) return new Response(pagina(["https://www.botosaneanul.ro/stire-importanta"]));
  if (u.endsWith("/reportaj")) {
    apeluri++;
    if (apeluri === 1) throw new TypeError("terminated"); // prima încercare cade, a doua merge
    return new Response(pagina(["https://www.botosaneanul.ro/reportaj-nou"]));
  }
  if (u.endsWith("/top-news")) return new Response("eroare", { status: 500 });
  throw new Error("fetch neașteptat: " + u);
};
const r = await fetchAllowedLinks(["https://www.botosaneanul.ro/stirea-zilei", "https://www.botosaneanul.ro/reportaj", "https://www.botosaneanul.ro/top-news"]);
assert.equal(r.ok, 2);
assert.equal(r.errors.length, 1);
assert.ok(r.allowed.has(normalizeUrl("https://www.botosaneanul.ro/stire-importanta")));
assert.ok(r.allowed.has(normalizeUrl("https://www.botosaneanul.ro/reportaj-nou")));
assert.ok(!r.allowed.has(normalizeUrl("https://www.botosaneanul.ro/articol-din-bara-laterala-care-nu-trebuie-inclus")));

const nimic = await fetchAllowedLinks(["https://www.botosaneanul.ro/top-news"]);
assert.equal(nimic.ok, 0); // cron-ul nu postează nimic în cazul ăsta

console.log("categorii: OK");
