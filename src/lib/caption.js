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
export async function aiCaption(site, title, rawSourceHtml, publishedAt = null) {
  const apiKey = site.openai_api_key || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const text = stripHtml(rawSourceHtml).slice(0, 2000);
  // prea puțin text → orice ar scrie AI-ul e invenție; rămânem pe titlu
  if (text.length < 120) return null;

  const special = SPECIAL_LABELS.find((s) => s.re.test(title));
  const pubDate = publishedAt
    ? new Intl.DateTimeFormat("ro-RO", { dateStyle: "full", timeZone: "Europe/Bucharest" }).format(publishedAt)
    : null;

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
              `Ești editor social media senior la un ziar românesc de știri (${site.name}). ` +
              `Primești o știre și scrii TEXTUL postării de Facebook.\n` +
              `SCOPUL: postarea trebuie să-l facă pe cititor să dea click pe linkul din primul comentariu ca să afle restul.\n` +
              `METODA DE LUCRU — întâi analizezi, apoi scrii:\n` +
              `1. Citește TOT textul și identifică UNGHIUL știrii: care e faptul cel mai important/nou/cu impact pentru cititorii locali (cine, ce, unde). Nu primul paragraf — faptul cel mai puternic.\n` +
              `2. Prima propoziție = unghiul, formulat direct și concret — cârligul care prinde atenția.\n` +
              `3. NU dezvălui tot: păstrează deznodământul, suma exactă, decizia finală sau detaliul-cheie PENTRU ARTICOL. Postarea deschide subiectul, articolul îl închide. (Ex: „Un șofer a fost prins cu o alcoolemie record în centrul orașului" — fără să spui cât, cine sau ce pedeapsă a primit.)\n` +
              `4. FĂRĂ NUMELE persoanelor din știre: descrie-le prin vârstă/profesie/localitate („un profesor de 47 de ani din Botoșani", „un tânăr din Dorohoi"). Numele, școala, firma, locul exact — se află DOAR în articol; asta îi face pe oameni să intre pe link. La fel, nu numi instituțiile/locurile secundare care identifică persoana.\n` +
              `5. Curiozitatea vine din faptele reale reținute, NU din exagerări sau formulări de tabloid. INTERZIS: „nu o să crezi", „șocant", „incredibil", majuscule întregi.\n` +
              `6. Română corectă cu diacritice, 1-2 emoji potrivite subiectului.\n` +
              `REGULI STRICTE:\n` +
              `- Folosește DOAR informații care apar EXPLICIT în textul primit. Nu deduce, nu completa, nu presupune.\n` +
              `- Date calendaristice: menționezi o dată DOAR dacă apare explicit în textul știrii (data unui eveniment). Data publicării NU se menționează — e doar context pentru tine (poți spune „astăzi"/„ieri" doar dacă e clar din text și context).\n` +
              `- INTERZIS: cifre, nume, locuri sau interpretări care NU apar în text.\n` +
              `- Ton faptic de știre — nu comunicat de presă, nu laude, nu limbaj de lemn.\n` +
              `- Dacă textul e sărac în detalii, reformulează doar titlul, fără să adaugi nimic.\n` +
              (special ? `- Postarea începe OBLIGATORIU cu rândul: ${special.label}\n` : "") +
              `Apoi, pe rând nou: ${DETAILS_LINE}. FĂRĂ nicio întrebare către cititori — postarea se termină cu faptele. ` +
              `Fără linkuri, fără hashtag-uri. Răspunzi DOAR cu textul postării.`,
          },
          {
            role: "user",
            content:
              `Titlu: ${title}\n` +
              (pubDate ? `Data publicării (doar context, NU o menționa): ${pubDate}\n` : "") +
              `\nTextul știrii: ${text}`,
          },
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
