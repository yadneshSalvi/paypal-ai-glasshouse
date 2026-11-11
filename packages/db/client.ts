import postgres from 'postgres';
import { schema } from './schema';

export interface Database {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
}

function postgresAdapter(sql: postgres.Sql): Database {
  return {
    async query<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
      // postgres.js serializes parameters inferred as jsonb itself. Decode our SQL-bound JSON
      // text once so it is not stored as a JSON string instead of an object or array.
      const parameters=values.map((value,index)=>typeof value==='string'&&new RegExp('\\$'+(index+1)+'\\s*::\\s*jsonb\\b','i').test(text)?JSON.parse(value):value);
      return await sql.unsafe(text, parameters as postgres.ParameterOrJSON<never>[]) as unknown as T[];
    },
    async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      return await sql.begin(tx => fn(postgresAdapter(tx as unknown as postgres.Sql))) as unknown as T;
    },
  };
}

declare global { var glasshouseDatabase: Promise<Database> | undefined }

async function initialize(): Promise<Database> {
  let db: Database;
  if (process.env.DATABASE_URL) {
    const sql = postgres(process.env.DATABASE_URL, { max: 5, idle_timeout: 20, connect_timeout: 15, prepare: false, onnotice: () => {} });
    db = postgresAdapter(sql);
  } else {
    if (process.env.VERCEL) throw new Error('Durable DATABASE_URL is required on Vercel.');
    const { PGlite } = await import('@electric-sql/pglite');
    const { mkdir } = await import('node:fs/promises');
    await mkdir('.data/postgres', { recursive: true });
    const pg = new PGlite('.data/postgres');
    const adapt = (client: Pick<typeof pg, 'query'>): Database => ({
      async query<T extends Record<string, unknown>>(text: string, values: unknown[] = []) { return (await client.query<T>(text, values)).rows; },
      async transaction<T>(fn: (tx: Database) => Promise<T>) { return pg.transaction(tx => fn(adapt(tx))); },
    });
    db = adapt(pg);
  }
  // Each statement is idempotent; SQL constraints remain the authority across processes.
  for (const statement of schema.split(';').map(v => v.trim()).filter(Boolean)) await db.query(statement);
  return db;
}

export function database(): Promise<Database> {
  globalThis.glasshouseDatabase ??= initialize().catch(error => { globalThis.glasshouseDatabase = undefined; throw error; });
  return globalThis.glasshouseDatabase;
}
