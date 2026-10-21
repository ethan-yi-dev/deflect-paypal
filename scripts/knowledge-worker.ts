import { loadEnvConfig } from "@next/env";
import { setTimeout as delay } from "node:timers/promises";
import { getBinding, getProviderConfig, KnowledgeError } from "../lib/knowledge/config";
import { getPool, postgresDatabase } from "../lib/knowledge/database";
import { createKnowledgeProviders } from "../lib/knowledge/providers";
import { KnowledgeRepository } from "../lib/knowledge/repository";
import { processNextKnowledgeJob } from "../lib/knowledge/worker";

async function main() {
  loadEnvConfig(process.cwd());
  const binding = getBinding();
  const config = getProviderConfig();
  const pool = getPool();
  const repository = new KnowledgeRepository(postgresDatabase(pool), binding);
  const providers = createKnowledgeProviders(binding, config);
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  try {
    await repository.ensureBase();
    console.info(`Knowledge worker started for ${binding.id} (${binding.embeddingModel}, ${binding.embeddingDimensions} dimensions).`);
    while (!stop.signal.aborted) {
      try {
        await repository.recoverExpiredJobs();
        if (!await processNextKnowledgeJob(repository, providers, stop.signal)) await delay(1500, undefined, { signal: stop.signal });
      } catch {
        if (stop.signal.aborted) break;
        console.error("Knowledge worker could not access its queue. Retrying in 5 seconds.");
        await delay(5000, undefined, { signal: stop.signal }).catch(() => {});
      }
    }
  } finally { await pool.end(); }
}
main().catch((error: unknown) => {
  console.error(error instanceof KnowledgeError ? error.message : "Worker startup failed. Check PostgreSQL and run npm run db:migrate.");
  process.exitCode = 1;
});
