import { KnowledgeError, type RerankConfig } from "./config";
import type { KnowledgeProviders } from "./providers";
import type { KnowledgeRepository } from "./repository";
import type { KnowledgeReranker } from "./reranker";
import type { KnowledgeRetrieval, KnowledgeSearchResult } from "./types";

type RetrievalInput = {
  query: string;
  limit: number;
  signal: AbortSignal;
  repository: Pick<KnowledgeRepository, "binding" | "searchCandidates" | "retainSearchableHits">;
  providers: Pick<KnowledgeProviders, "embed">;
  reranker: KnowledgeReranker;
  config: RerankConfig;
};

export async function retrieveKnowledge({ query, limit, signal, repository, providers, reranker, config }: RetrievalInput): Promise<KnowledgeSearchResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new KnowledgeError("INVALID_LIMIT", "Search limit must be between 1 and 20.", 400);
  signal.throwIfAborted();
  const binding = repository.binding;
  const vector = await providers.embed(query, "query", "", signal);
  signal.throwIfAborted();
  const candidates = await repository.searchCandidates(vector, binding, config.candidateCount);
  let ranked = candidates;
  const retrieval: KnowledgeRetrieval = {
    rerankStatus: "empty", rerankerModel: null, candidateCount: candidates.length, warning: null,
  };
  if (candidates.length && !config.apiKey) {
    retrieval.rerankStatus = "not_configured";
    retrieval.warning = "Vector search only. Set COHERE_API_KEY in .env.local to enable reranking.";
  } else if (candidates.length) {
    try {
      ranked = await reranker(query, candidates, signal);
      retrieval.rerankStatus = "applied";
      retrieval.rerankerModel = config.model;
    } catch (error) {
      signal.throwIfAborted();
      retrieval.rerankStatus = "unavailable";
      const message = error instanceof KnowledgeError ? error.message : "The reranking service is unavailable.";
      retrieval.warning = `${message} Results are ordered by vector similarity.`;
    }
  }
  signal.throwIfAborted();
  // Recheck exact chunk IDs after the remote call: updates/reindexes can remove
  // old chunks, and soft deletion must take effect even during reranking.
  const eligible = await repository.retainSearchableHits(ranked);
  signal.throwIfAborted();
  return { knowledgeBase: binding, hits: eligible.slice(0, limit), retrieval };
}
