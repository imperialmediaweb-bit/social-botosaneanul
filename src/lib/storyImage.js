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

export async function composeStoryImage(imageUrl, title, siteName) {
  const res = await fetch(imageUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SocialBot/1.0)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`descărcarea pozei a eșuat (${res.status})`);
  const src = Buffer.from(await res.arrayBuffer());

  const base = await sharp(src).resize(W, H, { fit: "cover", position: "attention" }).toBuffer();

  const lines = wrapTitle(title);
  const fontSize = 64;
  const lineH = 82;
  const blockH = lines.length * lineH;
  const textBottom = H - 150; // deasupra zonei de UI a Facebook-ului
  const firstY = textBottom - blockH + lineH;

  const tspans = lines
    .map((l, i) => `<text x="70" y="${firstY + i * lineH}" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#ffffff">${escXml(l)}</text>`)
    .join("");

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="45%" stop-color="rgba(2,4,30,0)"/>
        <stop offset="100%" stop-color="rgba(2,4,30,0.94)"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <rect x="70" y="${firstY - lineH - 26}" width="14" height="${blockH + 20}" fill="#3B56D4"/>
    <text x="70" y="${firstY - lineH - 44}" font-family="DejaVu Sans, sans-serif" font-size="34" font-weight="bold" fill="#9db2ff" letter-spacing="3">${escXml(String(siteName || "").toUpperCase())}</text>
    ${tspans}
  </svg>`;

  return sharp(base)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}
