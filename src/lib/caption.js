import { stripHtml } from "./entities.js";

const DETAILS_LINE = "📌 Detalii complete în primul comentariu 👇";

// Rubrici speciale ale ziarului, aproape fără text (poză/citat): eticheta
// intră la începutul postării, iar AI-ul nu are voie să brodeze nimic.
const SPECIAL_LABELS = [
  { re: /declara[țt]ia zilei/i, label: "🗣️ DECLARAȚIA ZILEI" },
  { re: /poza zilei/i, label: "📷 POZA ZILEI" },
  { re: /faza zilei/i, label: "🎬 FAZA ZILEI" },
];

export function fallbackCaption(title) {
  const special = SPECIAL_LABELS.find((s) => s.re.test(title));
  const head = special ? `${special.label}\n${title}` : title;
  return `${head}\n\n${DETAILS_LINE}`;
}

// Caption AI: 2-3 propoziții, STRICT pe baza textului real al articolului.
// Reguli anti-halucinație: fără date calendaristice/cifre/nume care nu apar
// în text; text sărac → nu chemăm AI-ul deloc (fallback pe titlu).
export async function aiCaption(site, title, rawSourceHtml) {
  const apiKey = site.openai_api_key || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const text = stripHtml(rawSourceHtml).slice(0, 1500);
  // prea puțin text → orice ar scrie AI-ul e invenție; rămânem pe titlu
  if (text.length < 120) return null;

  const special = SPECIAL_LABELS.find((s) => s.re.test(title));

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 220,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content:
              `Ești editor social media pentru pagina de Facebook a unui site de știri românesc (${site.name}). ` +
              `Primești titlul și textul unei știri și scrii TEXTUL postării: 2-3 propoziții scurte, română corectă cu diacritice, 1-2 emoji potrivite.\n` +
              `REGULI STRICTE:\n` +
              `- Folosește DOAR informații care apar EXPLICIT în textul primit. Nu deduce, nu completa, nu presupune.\n` +
              `- INTERZIS să menționezi date calendaristice, cifre, nume sau locuri care NU apar în text.\n` +
              `- Dacă textul e sărac în detalii, reformulează doar titlul, fără să adaugi nimic.\n` +
              (special ? `- Postarea începe OBLIGATORIU cu rândul: ${special.label}\n` : "") +
              `Apoi, pe rând nou: ${DETAILS_LINE}. FĂRĂ nicio întrebare către cititori — postarea se termină cu faptele. ` +
              `Fără linkuri, fără hashtag-uri. Răspunzi DOAR cu textul postării.`,
          },
          { role: "user", content: `Titlu: ${title}\n\nTextul știrii: ${text}` },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    let out = (data?.choices?.[0]?.message?.content || "").trim();
    if (!out) return null;
    if (special && !out.includes(special.label.replace(/^[^\s]+\s/, ""))) {
      out = `${special.label}\n${out}`;
    }
    if (!out.includes("primul comentariu")) out = `${out}\n\n${DETAILS_LINE}`;
    return out;
  } catch {
    return null;
  }
}
