import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { targets } from './schema.js';

/**
 * One-shot migration + seed entrypoint (docker compose `migrate` service and
 * `pnpm --filter @replay/db migrate`). Applies pending Drizzle migrations and
 * upserts the known target rows: runs.target_id has a foreign key to targets,
 * so POST /api/runs fails on a fresh database without this seed.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../migrations');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[migrate] DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1 });
const db = drizzle(sql);

try {
  await migrate(db, { migrationsFolder });
  console.log('[migrate] migrations applied');

  await db
    .insert(targets)
    .values({
      id: 'demo-shop',
      name: 'Demo Shop',
      repoPath: 'targets/demo-shop',
      sandboxImage: 'replay-demo-shop',
      localBaseUrl: 'http://localhost:5173',
      testCommand: 'pnpm test',
    })
    .onConflictDoNothing();
  console.log('[migrate] demo-shop target seeded');

  await sql.end();
  process.exit(0);
} catch (err) {
  console.error('[migrate] failed:', (err as Error).message);
  await sql.end().catch(() => {});
  process.exit(1);
}
