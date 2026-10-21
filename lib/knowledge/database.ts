import { Pool } from "pg";
import { KnowledgeError } from "./config";

export type Sql = <T extends object = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<T[]>;
export type Database = { query: Sql; transaction: <T>(work: (sql: Sql) => Promise<T>) => Promise<T> };
const globalDb = globalThis as typeof globalThis & { knowledgePool?: Pool };

export function getPool() {
  if (!process.env.DATABASE_URL) throw new KnowledgeError("DATABASE_NOT_CONFIGURED", "Set DATABASE_URL in .env.local and run npm run db:migrate.", 503);
  if (!globalDb.knowledgePool) {
    globalDb.knowledgePool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
    globalDb.knowledgePool.on("error", () => console.error("Knowledge database connection lost."));
  }
  return globalDb.knowledgePool;
}

export function postgresDatabase(pool: Pool): Database {
  return {
    query: async <T extends object>(text: string, values?: unknown[]) => (await pool.query(text, values)).rows as T[],
    transaction: async (work) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(async <T extends object>(text: string, values?: unknown[]) => (await client.query(text, values)).rows as T[]);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
