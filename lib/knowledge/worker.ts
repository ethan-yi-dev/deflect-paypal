import { KnowledgeError } from "./config";
import { chunkPages, type KnowledgeProviders } from "./providers";
import type { KnowledgeRepository } from "./repository";
import type { KnowledgeChunk } from "./types";

export async function processNextKnowledgeJob(repository: KnowledgeRepository, providers: KnowledgeProviders, stopSignal?: AbortSignal) {
  const job = await repository.claimJob();
  if (!job) return false;
  const controller = new AbortController();
  const signal = stopSignal ? AbortSignal.any([controller.signal, stopSignal]) : controller.signal;
  const heartbeat = setInterval(() => {
    void repository.renewLease(job).catch(() => controller.abort(new Error("Worker lease lost.")));
  }, 30000);
  heartbeat.unref();
  let step = "load";
  try {
    const document = await repository.loadJobDocument(job);
    step = "parse";
    const pages = document.contentType === "application/pdf" && document.pdf
      ? await providers.parse(document.pdf, document.name, signal)
      : [{ pageNumber: 1, text: document.text ?? "" }];
    step = "chunk";
    const parts = chunkPages(pages);
    const chunks: KnowledgeChunk[] = [];
    step = "embed";
    for (const part of parts) {
      signal.throwIfAborted();
      const embedding = await providers.embed(part.text, "document", document.name, signal);
      chunks.push({ ...part, embedding });
    }
    signal.throwIfAborted();
    step = "store";
    await repository.completeJob(job, chunks);
    console.info(`Knowledge document ${job.docId}: success (${chunks.length} chunks).`);
  } catch (error) {
    const message = error instanceof KnowledgeError ? error.message
      : signal.aborted ? "The worker stopped or lost its lease. Retry indexing."
      : "Indexing failed or timed out. Check the provider connections and retry.";
    // Retain call frames without copying raw provider payloads or transport errors.
    const frames = error instanceof Error ? (error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line)) : [];
    await repository.failJob(job, `${step}: ${message}`, { step, stack: [message, ...frames].join("\n") });
    console.error(`Knowledge document ${job.docId}: failed. ${message}`);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
