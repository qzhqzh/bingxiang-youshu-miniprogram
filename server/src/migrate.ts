import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const databaseUrl = process.env.BINGXIANG_DATABASE_URL;
if (!databaseUrl) throw new Error('缺少 BINGXIANG_DATABASE_URL');

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(migrationsDir)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of files) {
    const applied = await client.query<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1) AS exists', [name]);
    if (applied.rows[0]?.exists) continue;
    const sql = await readFile(join(migrationsDir, name), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      process.stdout.write(`applied ${name}\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.end();
}
