import { KnowledgeError } from "./config";
import { chunkPages, type KnowledgeProviders } from "./providers";
import { validateVector, type KnowledgeRepository, type ProcessingRun } from "./repository";
import type { KnowledgeChunk, ProcessingStage } from "./types";

// The caller awaits the whole pipeline. There is no detached task or queue consumer.
export async function processKnowledgeDocument(repository: KnowledgeRepository, docId: string, providers: KnowledgeProviders, stopSignal?: AbortSignal) {
  stopSignal?.throwIfAborted();
  const { run } = await repository.startProcessing(docId);
  await processKnowledgeRun(repository, providers, run, stopSignal);
  return repository.document(docId);
}

export async function processKnowledgeRun(repository: KnowledgeRepository, providers: KnowledgeProviders, run: ProcessingRun, stopSignal?: AbortSignal) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60 * 1000), ...(stopSignal ? [stopSignal] : [])]);
  const heartbeat = setInterval(() => {
    void repository.renewLease(run).catch(() => controller.abort(new Error("Processing lease lost.")));
  }, 30000);
  heartbeat.unref();
  let step: ProcessingStage = "load";
  try {
    signal.throwIfAborted();
    const document = await repository.loadJobDocument(run);
    step = "parse";
    await repository.updateProgress(run, step);
    signal.throwIfAborted();
    const pages = document.contentType === "application/pdf" && document.pdf
      ? await providers.parse(document.pdf, document.name, signal)
      : [{ pageNumber: 1, text: document.text ?? "" }];
    signal.throwIfAborted();
    step = "chunk";
    await repository.updateProgress(run, step);
    const parts = chunkPages(pages);
    const chunks: KnowledgeChunk[] = [];
    step = "embed";
    await repository.updateProgress(run, step, 0, parts.length);
    for (const part of parts) {
      signal.throwIfAborted();
      const embedding = await providers.embed(part.text, "document", document.name, signal);
      signal.throwIfAborted();
      validateVector(embedding, repository.binding.embeddingDimensions);
      chunks.push({ ...part, embedding });
      await repository.updateProgress(run, step, chunks.length, parts.length);
    }
    step = "store";
    await repository.updateProgress(run, step, chunks.length, parts.length);
    signal.throwIfAborted();
    // Publish all chunks and the successful document state in one transaction.
    await repository.completeJob(run, chunks);
  } catch (error) {
    const message = signal.aborted ? "Processing was interrupted or timed out. Retry processing."
      : error instanceof KnowledgeError ? error.message
      : "Processing failed. Check the provider connections and retry.";
    // Keep call frames, excluding raw provider payloads or transport credentials.
    const frames = error instanceof Error ? (error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line)) : [];
    await repository.failJob(run, `${step}: ${message}`, { step, stack: [message, ...frames].join("\n") });
  } finally {
    clearInterval(heartbeat);
  }
}
