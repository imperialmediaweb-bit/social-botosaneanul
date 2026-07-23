import express from "express";
import { ensureSchema } from "./db.js";
import { runSocialPost } from "./cron.js";
import { SITES } from "./sites.js";

const app = express();

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "social-botosaneanul", sites: SITES.map((s) => s.slug) });
});

app.get("/api/cron/social-post", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.query.key !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const result = await runSocialPost({
      siteSlug: req.query.site || null,
      force: req.query.force === "1",
      dry: req.query.dry === "1",
    });
    res.json(result);
  } catch (e) {
    console.error("cron error:", e);
    res.status(500).json({ error: e.message });
  }
});

const port = parseInt(process.env.PORT || "3000", 10);

ensureSchema()
  .then(() => {
    app.listen(port, () => console.log(`social-bot ascultă pe :${port}`));
  })
  .catch((e) => {
    console.error("DB schema init failed:", e);
    process.exit(1);
  });
