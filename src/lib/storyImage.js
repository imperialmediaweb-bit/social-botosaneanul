import sharp from "sharp";

// Compune imaginea de Story (1080×1920): poza articolului pe tot cadrul,
// gradient închis jos, titlul articolului cu diacritice + numele publicației.
// (Stories API nu suportă text prin API — de aceea textul se "coace" în poză.)
const W = 1080;
const H = 1920;

function escXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// împarte titlul în rânduri de maxim ~26 caractere, maxim 5 rânduri
function wrapTitle(title, maxChars = 26, maxLines = 5) {
  const words = String(title || "").trim().split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines - 1) break;
    } else {
      line = (line + " " + w).trim();
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  // dacă titlul a fost tăiat, adaugă „…" pe ultimul rând
  const used = lines.join(" ").length;
  if (used < String(title || "").trim().length && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*\S*$/, "") + "…";
  }
  return lines;
}

// Card de brand 1200×630 pentru articolele FĂRĂ nicio poză (unele știri „din
// surse" n-au ilustrație). Astfel postarea rămâne nativă cu imagine, în loc
// de preview de link — care are reach slab și pune linkul în postare.
export async function composeBrandCard(title, siteName, slug = "") {
  const theme = SITE_THEMES[slug] || DEFAULT_THEME;
  const logo = await fetchLogo(theme.logo, 420);
  const CW = 1200;
  const CH = 630;

  const lines = wrapTitle(title, 30, 4);
  const fontSize = 58;
  const lineH = 74;
  const blockTop = 300 - ((lines.length - 1) * lineH) / 2;

  const tspans = lines
    .map((l, i) => `<text x="${CW / 2}" y="${blockTop + i * lineH}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#ffffff">${escXml(l)}</text>`)
    .join("");

  const svg = `<svg width="${CW}" height="${CH}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${theme.stops[0]}"/>
        <stop offset="55%" stop-color="${theme.stops[1]}"/>
        <stop offset="100%" stop-color="${theme.stops[2]}"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    ${logo ? "" : `<text x="${CW / 2}" y="120" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="40" font-weight="bold" fill="#ffffff" letter-spacing="4">${escXml(String(siteName || "").toUpperCase())}</text>`}
    ${tspans}
    <rect x="${CW / 2 - 60}" y="${CH - 105}" width="120" height="6" fill="${theme.accent}"/>
  </svg>`;

  const layers = [];
  if (logo) layers.push({ input: logo.buf, top: 70, left: Math.round((CW - logo.w) / 2) });

  return sharp(Buffer.from(svg))
    .composite(layers)
    .jpeg({ quality: 90 })
    .toBuffer();
}

// Acceptă o LISTĂ de poze candidate: le încearcă pe rând și o folosește pe
// prima care se descarcă și se decodează la o mărime decentă (unele articole
// au ca primă poză un placeholder sau o imagine minusculă → story „gol").
async function fetchUsableImage(imageUrls) {
  const errors = [];
  for (const url of [].concat(imageUrls).filter(Boolean).slice(0, 5)) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const meta = await sharp(buf).metadata();
      if (!meta.width || meta.width < 400 || !meta.height || meta.height < 250) {
        throw new Error(`prea mică (${meta.width}x${meta.height})`);
      }
      return buf;
    } catch (e) {
      errors.push(`${url.slice(0, 60)}: ${e.message}`);
    }
  }
  throw new Error(`nicio poză utilizabilă — ${errors.join(" | ")}`);
}

// tema vizuală per publicație: culorile fundalului + logo-ul de sus.
// Botoșăneanul = albastrul din logo; Martor = negru cu text alb.
// Logo eșuat la descărcare → numele scris ca text.
export const SITE_THEMES = {
  botosaneanul: {
    stops: ["#151f66", "#1d2b7d", "#2e3e9e"],
    accent: "#8fa3ff",
    logo: "https://www.botosaneanul.ro/assets/uploads/media-uploader/logo1684429147.png",
  },
  "martor-incomod": {
    stops: ["#000000", "#0d0d0d", "#1e1e1e"],
    accent: "#bfbfbf",
    logo: "https://www.botosaneanul.ro/assets/uploads/media-uploader/martor-incomod1769619399.jpg",
  },
};
const DEFAULT_THEME = { stops: ["#151f66", "#1d2b7d", "#2e3e9e"], accent: "#8fa3ff", logo: null };

const logoCache = new Map();
async function fetchLogo(url, width = 460) {
  if (!url) return null;
  const key = `${url}@${width}`;
  if (logoCache.has(key)) return logoCache.get(key);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SocialBot/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const logo = await sharp(buf).resize({ width }).png().toBuffer();
    const meta = await sharp(logo).metadata();
    const out = { buf: logo, w: meta.width, h: meta.height };
    logoCache.set(key, out);
    return out;
  } catch {
    logoCache.set(key, null);
    return null;
  }
}

// Layout „brand": fundalul în culorile publicației, logo-ul sus, poza
// articolului ca un card rotunjit, titlul pe alb dedesubt.
export async function composeStoryImage(imageUrls, title, siteName, slug = "") {
  const theme = SITE_THEMES[slug] || DEFAULT_THEME;
  const src = await fetchUsableImage(imageUrls);
  const logo = await fetchLogo(theme.logo);

  // cardul cu poza: 940×1050, colțuri rotunjite
  const PW = 940;
  const PH = 1050;
  const photo = await sharp(src).resize(PW, PH, { fit: "cover", position: "attention" }).toBuffer();
  const mask = Buffer.from(
    `<svg width="${PW}" height="${PH}"><rect x="0" y="0" width="${PW}" height="${PH}" rx="30" ry="30" fill="#fff"/></svg>`
  );
  const roundedPhoto = await sharp(photo)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();

  const photoTop = 250;
  const photoLeft = (W - PW) / 2;

  const lines = wrapTitle(title);
  const fontSize = 62;
  const lineH = 80;
  const titleTop = photoTop + PH + 110;

  const tspans = lines
    .map((l, i) => `<text x="${W / 2}" y="${titleTop + i * lineH}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#ffffff">${escXml(l)}</text>`)
    .join("");

  // fundal: gradientul albastru al brandului + textele
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${theme.stops[0]}"/>
        <stop offset="55%" stop-color="${theme.stops[1]}"/>
        <stop offset="100%" stop-color="${theme.stops[2]}"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    ${logo ? "" : `<text x="${W / 2}" y="165" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="46" font-weight="bold" fill="#ffffff" letter-spacing="4">${escXml(String(siteName || "").toUpperCase())}</text>
    <rect x="${W / 2 - 70}" y="192" width="140" height="7" fill="${theme.accent}"/>`}
    ${tspans}
    <text x="${W / 2}" y="${H - 90}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="30" fill="${theme.accent}">▲ Detalii complete pe site</text>
  </svg>`;

  const layers = [{ input: roundedPhoto, top: photoTop, left: photoLeft }];
  if (logo) {
    layers.push({
      input: logo.buf,
      top: Math.max(60, Math.round(155 - logo.h / 2)),
      left: Math.round((W - logo.w) / 2),
    });
  }

  return sharp(Buffer.from(svg))
    .composite(layers)
    .jpeg({ quality: 88 })
    .toBuffer();
}
