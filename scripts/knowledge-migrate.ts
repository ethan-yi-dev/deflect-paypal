import { loadEnvConfig } from "@next/env";
import { readFile } from "node:fs/promises";
import { getPool, postgresDatabase } from "../lib/knowledge/database";

async function main() {
  loadEnvConfig(process.cwd());
  const pool = getPool();
  try {
    const sql = await readFile("db/migrations/001_knowledge_base.sql", "utf8");
    await postgresDatabase(pool).transaction(async (query) => {
      await query("SELECT pg_advisory_xact_lock(746483921)");
      await query(sql);
    });
    console.info("Knowledge schema is ready (PostgreSQL + pgvector).");
  } finally { await pool.end(); }
}
main().catch(() => { console.error("Migration failed. Check DATABASE_URL, database permissions, and the pgvector extension."); process.exitCode = 1; });
