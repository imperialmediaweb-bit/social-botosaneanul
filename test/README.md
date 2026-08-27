# Teste

Testele NU ating Facebook, feed-urile reale sau OpenAI — tot ce iese pe rețea
este simulat (mock pe `fetch`). Au nevoie doar de un Postgres local de test:

```bash
# implicit: postgres://runner@127.0.0.1:5433/social_test
# sau setează tu unul:
TEST_DATABASE_URL=postgres://user@localhost:5432/social_test npm test
```

Atenție: testele ȘTERG și recreează tabelele din baza de date de test —
nu folosi niciodată baza de producție aici.

- `incident-articole-in-rafala.test.mjs` — reproduce incidentul din 27.08.2026
  (articole publicate la câteva minute distanță; unul refuzat de Meta):
  ordinea de postare, carantina, marcarea `failed` după 24h, vizibilitatea în panou.
- `cascada-si-panou.test.mjs` — cascada de publicare (album → foto-URL →
  upload fișier → card de brand) + panoul de admin: login, rate-limit,
  roluri admin/client, secțiunea de erori.
- `titlu-original.test.mjs` — combinațiile bifelor „titlu original” ×
  „rând de detalii”: captionul exact, prin dry-run.
