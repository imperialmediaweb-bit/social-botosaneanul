// Config site-uri. De extins aici (sau, în viitor, mutat în tabelul `sites`
// din DB când facem panoul de admin).
export const SITES = [
  {
    slug: "botosaneanul",
    name: "Botoșăneanul",
    feedUrl: process.env.BOTOSANEANUL_FEED_URL || "https://www.botosaneanul.ro/rss",
    pageIdEnv: "BOTOSANEANUL_FB_PAGE_ID",
    tokenEnv: "BOTOSANEANUL_FB_ACCESS_TOKEN",
    openaiKeyEnv: "BOTOSANEANUL_OPENAI_API_KEY",
  },
];

export function getSite(slug) {
  return SITES.find((s) => s.slug === slug) || null;
}
