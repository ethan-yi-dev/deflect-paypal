import type { ModelBinding } from "./types";

export class KnowledgeError extends Error {
  constructor(public code: string, message: string, public status = 500) {
    super(message);
    this.name = "KnowledgeError";
  }
}

export function getBinding(env: Record<string, string | undefined> = process.env): ModelBinding {
  const embeddingModel = env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2";
  const embeddingDimensions = Number(env.GEMINI_EMBEDDING_DIMENSIONS || 768);
  if (!["gemini-embedding-2", "gemini-embedding-001"].includes(embeddingModel)
      || !Number.isInteger(embeddingDimensions) || embeddingDimensions < 1 || embeddingDimensions > 3072) {
    throw new KnowledgeError("INVALID_EMBEDDING_CONFIG", "Set a supported Gemini embedding model and dimensions between 1 and 3072.", 503);
  }
  return { id: env.KNOWLEDGE_BASE_ID || "default", embeddingModel, embeddingDimensions };
}

export function assertBinding(actual: ModelBinding, expected: ModelBinding) {
  if (actual.id !== expected.id || actual.embeddingModel !== expected.embeddingModel || actual.embeddingDimensions !== expected.embeddingDimensions) {
    throw new KnowledgeError("EMBEDDING_MODEL_MISMATCH", "The embedding model or dimensions differ from this knowledge base. Restore its original configuration, or create a new knowledge base and reindex.", 409);
  }
}

export function getProviderConfig(env: Record<string, string | undefined> = process.env) {
  const geminiKey = env.GEMINI_API_KEY?.trim();
  const llamaKey = env.LLAMA_CLOUD_API_KEY?.trim();
  if (!geminiKey || !llamaKey || geminiKey === "anyword" || llamaKey === "anyword") {
    throw new KnowledgeError("PROVIDER_NOT_CONFIGURED", "Set GEMINI_API_KEY and LLAMA_CLOUD_API_KEY in .env.local before starting indexing.", 503);
  }
  const tier = env.LLAMA_PARSE_TIER || "agentic";
  if (!["fast", "cost_effective", "agentic", "agentic_plus"].includes(tier)) {
    throw new KnowledgeError("INVALID_PARSE_TIER", "LLAMA_PARSE_TIER is invalid.", 503);
  }
  return { geminiKey, llamaKey, tier };
}

// Querying uses embeddings only; LlamaParse credentials are needed for PDF indexing.
export function getEmbeddingConfig(env: Record<string, string | undefined> = process.env) {
  const geminiKey = env.GEMINI_API_KEY?.trim();
  if (!geminiKey || geminiKey === "anyword") throw new KnowledgeError("PROVIDER_NOT_CONFIGURED", "Set GEMINI_API_KEY in .env.local before searching the knowledge base.", 503);
  return { geminiKey };
}

export function getRerankConfig(env: Record<string, string | undefined> = process.env) {
  const key = env.COHERE_API_KEY?.trim();
  const model = env.COHERE_RERANK_MODEL?.trim() || "rerank-v4.0-fast";
  const candidateCount = Number(env.KNOWLEDGE_RERANK_CANDIDATES || 50);
  const timeoutMs = Number(env.KNOWLEDGE_RERANK_TIMEOUT_MS || 10000);
  if (!/^rerank-[a-z0-9._-]{1,100}$/i.test(model)
      || !Number.isInteger(candidateCount) || candidateCount < 20 || candidateCount > 100
      || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    throw new KnowledgeError("INVALID_RERANK_CONFIG", "Set a rerank model, 20–100 candidates, and a timeout between 100 and 60000 ms.", 503);
  }
  return { apiKey: key && key !== "anyword" ? key : null, model, candidateCount, timeoutMs };
}

export type RerankConfig = ReturnType<typeof getRerankConfig>;
