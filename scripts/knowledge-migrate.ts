import { loadEnvConfig } from "@next/env";
import { readFile, readdir } from "node:fs/promises";
import { getPool, postgresDatabase } from "../lib/knowledge/database";

async function main() {
  loadEnvConfig(process.cwd());
  const pool = getPool();
  try {
    const files = (await readdir("db/migrations")).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    const migrations = await Promise.all(files.map((name) => readFile(`db/migrations/${name}`, "utf8")));
    await postgresDatabase(pool).transaction(async (query) => {
      await query("SELECT pg_advisory_xact_lock(746483921)");
      for (const sql of migrations) await query(sql);
    });
    console.info("Database schema is ready (knowledge base and evidence submissions).");
  } finally { await pool.end(); }
}
main().catch(() => { console.error("Migration failed. Check DATABASE_URL, database permissions, and the pgvector extension."); process.exitCode = 1; });
