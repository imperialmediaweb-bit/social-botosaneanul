import { stripHtml } from "./entities.js";

const DETAILS_LINE = "📌 Detalii complete în primul comentariu 👇";

export function fallbackCaption(title) {
  return `${title}\n\n${DETAILS_LINE}`;
}

// Caption AI: 2-3 propoziții, strict faptic, FĂRĂ întrebare finală (decizie fermă).
// La orice eroare → fallback pe titlu simplu.
export async function aiCaption(site, title, rawSummaryHtml) {
  const apiKey = site.openai_api_key || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const summary = stripHtml(rawSummaryHtml).slice(0, 900);
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
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content:
              `Ești editor social media pentru pagina de Facebook a unui site de știri românesc (${site.name}). ` +
              `Primești titlul și rezumatul unei știri și scrii TEXTUL postării: 2-3 propoziții scurte, română corectă cu diacritice, ` +
              `STRICT faptic (nu inventa nimic ce nu e în rezumat), 1-2 emoji potrivite. Apoi, pe rând nou: ` +
              `${DETAILS_LINE}. FĂRĂ nicio întrebare către cititori — postarea se termină cu faptele. ` +
              `Fără linkuri, fără hashtag-uri. Răspunzi DOAR cu textul postării.`,
          },
          { role: "user", content: `Titlu: ${title}\n\nRezumat: ${summary}` },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    let text = (data?.choices?.[0]?.message?.content || "").trim();
    if (!text) return null;
    if (!text.includes("primul comentariu")) text = `${text}\n\n${DETAILS_LINE}`;
    return text;
  } catch {
    return null;
  }
}
