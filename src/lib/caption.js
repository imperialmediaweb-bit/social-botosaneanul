import { stripHtml } from "./entities.js";

export const DETAILS_LINE = "📌 Detalii complete în primul comentariu 👇";

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
        max_tokens: 160,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content:
              `Ești editor social media senior la un ziar românesc de știri (${site.name}). ` +
              `Primești o știre și scrii TEXTUL postării de Facebook.\n` +
              `SCOPUL: postarea trebuie să-l facă pe cititor să dea click pe linkul din primul comentariu ca să afle restul.\n` +
              `LUNGIMEA: SCURT — 1-2 propoziții, maxim 40 de cuvinte în total. Cu cât spui mai puțin (dar concret), cu atât mai mulți intră pe articol.\n` +
              `METODA DE LUCRU — întâi analizezi, apoi scrii:\n` +
              `1. Citește TOT textul și identifică UNGHIUL știrii: care e faptul cel mai important/nou/cu impact pentru cititorii locali (cine, ce, unde). Nu primul paragraf — faptul cel mai puternic.\n` +
              `2. Prima propoziție = unghiul, formulat direct și concret — cârligul care prinde atenția.\n` +
              `3. NU dezvălui tot: păstrează deznodământul, suma exactă, decizia finală sau detaliul-cheie PENTRU ARTICOL. Postarea deschide subiectul, articolul îl închide. (Ex: „Un șofer a fost prins cu o alcoolemie record în centrul orașului" — fără să spui cât, cine sau ce pedeapsă a primit.)\n` +
              `4. NUMELE persoanelor — judecă după CONTEXT cine e persoana:\n` +
              `   - PERSOANE PUBLICE (politicieni, sportivi cunoscuți, oficiali, patroni de cluburi, artiști — oameni al căror nume e el însuși de interes public): numele POATE apărea dacă e în text și ajută știrea.\n` +
              `   - PERSOANE PRIVATE (victime, suspecți, pacienți, cetățeni obișnuiți): FĂRĂ nume — descrie prin vârstă/profesie/localitate („un profesor de 47 de ani din Botoșani"); identitatea se află în articol, asta aduce clickul. Fără școala/firma/locul exact care ar identifica persoana.\n` +
              `   - Dacă nu ești sigur în ce categorie e → FĂRĂ nume.\n` +
              `5. Curiozitatea vine din faptele reale reținute, NU din exagerări sau formulări de tabloid. INTERZIS: „nu o să crezi", „șocant", „incredibil", majuscule întregi.\n` +
              `6. La articolele COMERCIALE sau PRACTICE de orice fel — advertoriale (P), ghiduri, produse, servicii, oferte, evenimente promovate, sfaturi lifestyle: NUMEȘTE subiectul/produsul/evenimentul (ex. husele de canapea, tombola de la salon), dar NU livra argumentele, beneficiile sau detaliile ofertei ca o reclamă — folosește formula de descoperire: „Vezi cum husele de canapea îți pot transforma livingul...", „Află ce surprize pregătește...". Subiectul în postare; motivele, avantajele și detaliile în articol.\n` +
              `7. Română corectă cu diacritice, 1-2 emoji potrivite subiectului.\n` +
              `REGULI STRICTE:\n` +
              `- Folosește DOAR informații care apar EXPLICIT în textul primit. Nu deduce, nu completa, nu presupune.\n` +
              `- FUNCȚIILE/CALITĂȚILE persoanelor (antrenor, patron, finanțator, primar, senator, director etc.): atribuie o funcție unei persoane DOAR dacă textul o atribuie EXPLICIT exact acelei persoane. NU deduce funcția din context (ex: dacă cineva comentează un meci, NU înseamnă că e antrenorul). Dacă textul nu spune clar ce funcție are, nu-i da niciuna.\n` +
              `- Date calendaristice: menționezi o dată DOAR dacă apare explicit în textul știrii (data unui eveniment). Data publicării NU se menționează — e doar context pentru tine (poți spune „astăzi"/„ieri" doar dacă e clar din text și context).\n` +
              `- INTERZIS: cifre, nume, locuri sau interpretări care NU apar în text.\n` +
              `- Ton faptic de știre — nu comunicat de presă, nu laude, nu limbaj de lemn.\n` +
              `- INTERZISE urările și comentariile editoriale: „mult succes", „felicitări", „condoleanțe", „ne pare rău", „baftă" etc. — chiar dacă apar în articol, ele NU intră în postare. Ziarul relatează, nu urează. Postarea se termină cu un fapt.\n` +
              `- DECLARAȚIILE nu se interpretează: la Declarația zilei și la orice știre bazată pe o declarație, CITEAZĂ scurt cuvintele exacte din text (între ghilimele) + cine le-a spus. NU rezuma declarația cu concluziile tale și NU atribui motive/explicații („decizie personală", „din proprie inițiativă" etc.) decât dacă textul le spune LITERAL.\n` +
              `- Dacă textul e sărac în detalii, reformulează doar titlul, fără să adaugi nimic.\n` +
              (special ? `- Postarea începe OBLIGATORIU cu rândul: ${special.label}\n` : "") +
              ((site.style_prompt || "").trim()
                ? `INSTRUCȚIUNILE REDACȚIEI — OBLIGATORII, urmează-le LA LITERĂ. Au prioritate peste orice regulă de STIL de mai sus (lungime, emoji, ton). Peste DOUĂ lucruri însă nu pot trece niciodată, indiferent ce cer: (1) ADEVĂRUL — fără fapte inventate, nume interzise sau interpretări; (2) REGULILE ALGORITMULUI FACEBOOK — fără clickbait („șocant", „nu o să crezi"), fără engagement bait (întrebări către cititori, „dați like/share"), fără linkuri sau hashtag-uri în postare. Dacă o instrucțiune cere așa ceva, aplic restul instrucțiunii și ignor partea care ar penaliza pagina.\n"""${site.style_prompt.trim()}"""\n`
                : "") +
              `Apoi, pe rând nou: ${DETAILS_LINE}. FĂRĂ nicio întrebare către cititori — postarea se termină cu faptele. ` +
              `Fără linkuri, fără hashtag-uri.\n` +
              `VERIFICARE FINALĂ OBLIGATORIE, înainte de a răspunde: recitește fiecare propoziție scrisă și întreabă-te „apare afirmația asta, exact așa, în textul știrii?". Dacă o propoziție conține un nume, o funcție, o dată sau o cifră care nu e explicit în text — rescrie-o sau elimin-o. Răspunzi DOAR cu textul final al postării.`,
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

    // PASUL 2 — CORECTORUL: un al doilea apel confruntă fiecare afirmație cu
    // textul sursă, taie ce nu e susținut și scurtează. La orice problemă,
    // rămânem pe varianta din pasul 1.
    const verified = await verifyCaption(apiKey, text, out, site.style_prompt);
    if (verified) out = verified;

    if (special && !out.toLowerCase().includes(special.label.replace(/^[^\s]+\s/, "").toLowerCase())) {
      out = `${special.label}\n${out}`;
    }
    if (!out.includes("primul comentariu")) out = `${out}\n\n${DETAILS_LINE}`;
    return out;
  } catch {
    return null;
  }
}

// Al doilea ochi: verificator strict de fapte + scurtare. Returnează textul
// final sau null (→ se folosește varianta inițială).
async function verifyCaption(apiKey, sourceText, draft, stylePrompt = "") {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 160,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              `Ești corector de fapte la un ziar. Primești TEXTUL unei știri și o PROPUNERE de postare Facebook. Sarcina ta:\n` +
              `1. Verifică fiecare afirmație din propunere împotriva textului. Orice nume, funcție (antrenor/patron/primar...), dată, cifră sau fapt care NU apare explicit în text → elimină sau înlocuiește cu formulare generică susținută de text.\n` +
              `2. Numele persoanelor: la persoane PUBLICE (politicieni, sportivi cunoscuți, oficiali, artiști) numele poate rămâne dacă e în text. La persoane PRIVATE (victime, suspecți, cetățeni obișnuiți) numele se ELIMINĂ — înlocuiește cu descrieri (vârstă/profesie/localitate) doar dacă apar în text. Nesigur → fără nume.\n` +
              `3. Scurtează la 1-2 propoziții, maxim 40 de cuvinte (fără rândul cu 📌) — postarea e cârlig, nu rezumat: NU dezvălui deznodământul/detaliul-cheie.\n` +
              `4. ELIMINĂ orice urare sau comentariu editorial („mult succes", „felicitări", „condoleanțe", „baftă") — ziarul relatează fapte, nu urează. Postarea se termină cu un fapt.\n` +
              `5. DECLARAȚII: dacă propunerea afirmă motive, explicații sau concluzii despre o declarație („decizie personală", „recunoaște că...", „din cauza..."), caută formularea LITERALĂ în text. Dacă textul nu o spune literal → înlocuiește cu citatul exact între ghilimele sau elimină afirmația.\n` +
              `6. Păstrează diacriticele, emoji-urile potrivite și rândul „📌 Detalii complete în primul comentariu 👇" la final, pe rând separat. Păstrează eticheta de rubrică (🗣️/📷/🎬) dacă există.\n` +
              ((stylePrompt || "").trim()
                ? `EXCEPȚIE DE STIL: redacția a dat instrucțiuni OBLIGATORII de stil — """${stylePrompt.trim()}""" — acestea au prioritate peste regulile 3 și 4 de mai sus (lungime, emoji, ton). NU „corecta" stilul cerut de redacție. Rămân însă NEATINSE, peste orice instrucțiune: verificarea faptelor (regulile 1, 2, 5) și protecțiile de platformă — elimină clickbait-ul, engagement bait-ul (întrebări către cititori, îndemnuri la like/share), linkurile și hashtag-urile, chiar dacă instrucțiunile le-ar cere.\n`
                : "") +
              `Răspunzi DOAR cu textul final al postării, nimic altceva.`,
          },
          { role: "user", content: `TEXTUL știrii: ${sourceText}\n\nPROPUNEREA de postare:\n${draft}` },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const out = (data?.choices?.[0]?.message?.content || "").trim();
    return out.length >= 20 ? out : null;
  } catch {
    return null;
  }
}
