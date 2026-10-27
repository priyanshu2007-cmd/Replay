import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export * from './schema.js';
export { DEMO_SHOP_TARGET_SEED, runMigrationsAndSeed } from './migrate.js';

export function createDb(connectionString?: string) {
  const connStr = connectionString !== undefined ? connectionString : process.env.DATABASE_URL;
  if (!connStr) {
    throw new Error('DATABASE_URL environment variable is required to connect to the database.');
  }
  const client = postgres(connStr, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return drizzle(client, { schema });
}

export type DbClient = ReturnType<typeof createDb>;
