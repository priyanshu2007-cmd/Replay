import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { targets } from './schema.js';

export const DEMO_SHOP_TARGET_SEED = {
  id: 'demo-shop',
  name: 'Demo Shop',
  repoPath: 'targets/demo-shop',
  sandboxImage: 'replay-demo-shop',
  localBaseUrl: 'http://localhost:5173',
  testCommand: 'pnpm test',
} as const;

function resolveMigrationsFolder(explicitFolder?: string): string {
  if (explicitFolder) return explicitFolder;
  const moduleDir =
    typeof import.meta !== 'undefined' && import.meta.url
      ? path.dirname(fileURLToPath(import.meta.url))
      : typeof __dirname !== 'undefined'
        ? __dirname
        : process.cwd();

  const candidates = [
    path.resolve(moduleDir, '../migrations'),
    path.resolve(moduleDir, '../../packages/db/migrations'),
    path.resolve(moduleDir, '../../../packages/db/migrations'),
    path.resolve(process.cwd(), 'packages/db/migrations'),
    path.resolve(process.cwd(), 'migrations'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'meta', '_journal.json'))) {
      return candidate;
    }
  }
  return candidates[0] ?? path.resolve(process.cwd(), 'packages/db/migrations');
}

export interface RunMigrationsOptions {
  migrationsFolder?: string;
  sqlClient?: ReturnType<typeof postgres>;
  migrateFn?: (db: any, config: { migrationsFolder: string }) => Promise<void>;
}

/**
 * One-shot migration + seed entrypoint (docker compose `migrate` service and
 * `pnpm --filter @replay/db migrate`). Applies pending Drizzle migrations and
 * upserts the known target rows: runs.target_id has a foreign key to targets,
 * so POST /api/runs fails on a fresh database without this seed.
 */
export async function runMigrationsAndSeed(
  connectionString: string | undefined = process.env.DATABASE_URL,
  options: RunMigrationsOptions = {}
): Promise<void> {
  if (!connectionString && !options.sqlClient) {
    throw new Error('DATABASE_URL is required');
  }

  const migrationsFolder = resolveMigrationsFolder(options.migrationsFolder);
  const ownsClient = !options.sqlClient;
  const sql = options.sqlClient ?? postgres(connectionString!, { max: 1 });
  const db = drizzle(sql);
  const migrateFn = options.migrateFn ?? migrate;

  try {
    await migrateFn(db, { migrationsFolder });
    await sql`
      CREATE TABLE IF NOT EXISTS "rate_limit_hits" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "bucket_key" text NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS "rate_limit_hits_bucket_created_idx"
      ON "rate_limit_hits" USING btree ("bucket_key", "created_at")
    `;

    await db
      .insert(targets)
      .values({ ...DEMO_SHOP_TARGET_SEED })
      .onConflictDoNothing();
  } finally {
    if (ownsClient) {
      await sql.end().catch(() => {});
    }
  }
}

const invokedScript = process.argv[1] ? path.basename(process.argv[1]) : '';
if (invokedScript === 'migrate.ts' || invokedScript === 'migrate.js' || invokedScript === 'migrate.cjs') {
  runMigrationsAndSeed()
    .then(() => {
      console.log('[migrate] migrations applied and demo-shop target seeded');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[migrate] failed:', (err as Error).message);
      process.exit(1);
    });
}
