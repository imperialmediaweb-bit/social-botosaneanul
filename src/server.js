import "./lib/fontSetup.js"; // OBLIGATORIU primul: fonturile pentru Story-uri
import express from "express";
import { ensureSchema } from "./db.js";
import { runSocialPost } from "./cron.js";
import { seedSitesFromEnv } from "./sites.js";
import { admin } from "./admin.js";

const app = express();

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "social-botosaneanul", admin: "/admin" });
});

app.use("/admin", admin);

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

// erori scăpate din rute (inclusiv async, prin wrapperul din admin) → 500,
// nu proces mort
app.use((err, _req, res, _next) => {
  console.error("http error:", err);
  if (!res.headersSent) res.status(500).json({ error: "internal" });
});

// plasă de siguranță la nivel de proces: logăm, nu murim
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

const port = parseInt(process.env.PORT || "3000", 10);

ensureSchema()
  .then(() => seedSitesFromEnv())
  .then(() => {
    app.listen(port, () => console.log(`social-bot ascultă pe :${port}`));
  })
  .catch((e) => {
    console.error("DB schema init failed:", e);
    process.exit(1);
  });
