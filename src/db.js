import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "1" ? { rejectUnauthorized: false } : undefined,
});

export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS external_fb_posts (
      page_id TEXT NOT NULL,
      item_url TEXT NOT NULL,
      posted_at TIMESTAMP DEFAULT NOW(),
      fb_post_id TEXT,
      PRIMARY KEY (page_id, item_url)
    );
    CREATE TABLE IF NOT EXISTS cron_locks (
      name TEXT PRIMARY KEY,
      locked_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

// Lacăt global de rulare: o singură rulare a jobului odată.
// Lacătele mai vechi de 5 min sunt considerate moarte (proces crăpat) și se preiau.
export async function acquireLock(name) {
  const res = await pool.query(
    `INSERT INTO cron_locks (name, locked_at) VALUES ($1, NOW())
     ON CONFLICT (name) DO UPDATE SET locked_at = NOW()
     WHERE cron_locks.locked_at < NOW() - INTERVAL '5 minutes'
     RETURNING name`,
    [name]
  );
  return res.rowCount > 0;
}

export async function releaseLock(name) {
  await pool.query(`DELETE FROM cron_locks WHERE name = $1`, [name]);
}
