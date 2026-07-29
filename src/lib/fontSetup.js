import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// Serverele de producție nu au fonturi instalate → textul de pe imaginile de
// Story ar ieși pătrățele. Fonturile DejaVu sunt împachetate în repo
// (assets/fonts), iar aici generăm o configurație fontconfig care le arată
// bibliotecii de randare, ÎNAINTE ca sharp să fie folosit.
const fontsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/fonts");
const cfgDir = path.join(os.tmpdir(), "socialbot-fontconfig");
const cacheDir = path.join(cfgDir, "cache");

try {
  fs.mkdirSync(cacheDir, { recursive: true });
  const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontsDir}</dir>
  <dir>/usr/share/fonts</dir>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>
`;
  fs.writeFileSync(path.join(cfgDir, "fonts.conf"), conf);
  process.env.FONTCONFIG_PATH = cfgDir;
  process.env.FONTCONFIG_FILE = path.join(cfgDir, "fonts.conf");
} catch (e) {
  console.error("font setup failed (textul de pe story-uri poate ieși gol):", e.message);
}
