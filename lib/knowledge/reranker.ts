import { KnowledgeError, type RerankConfig } from "./config";
import type { SearchHit } from "./types";

export type KnowledgeReranker = (query: string, candidates: SearchHit[], signal: AbortSignal) => Promise<SearchHit[]>;

export function createCohereReranker(config: RerankConfig, fetcher: typeof fetch = fetch): KnowledgeReranker {
  return async (query, candidates, signal) => {
    signal.throwIfAborted();
    if (!candidates.length) return [];
    if (!config.apiKey) throw new KnowledgeError("RERANK_NOT_CONFIGURED", "Set COHERE_API_KEY in .env.local to enable reranking.", 503);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
    let response: Response;
    let payload: unknown;
    try {
      response = await fetcher("https://api.cohere.com/v2/rerank", {
        method: "POST", signal: requestSignal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, "X-Client-Name": "deflect-knowledge-base" },
        body: JSON.stringify({
          model: config.model, query,
          documents: candidates.map((hit) => JSON.stringify({ title: hit.documentName, content: hit.content })),
          // Rank every candidate so final eligibility checks can refill removed hits.
          top_n: candidates.length,
        }),
      });
      if (!response.ok) throw new KnowledgeError("RERANK_PROVIDER_ERROR", `Cohere rerank returned HTTP ${response.status}. Check its credentials, model, quota, and service availability.`, 502);
      payload = await response.json();
      requestSignal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError("RERANK_UNAVAILABLE", "Cohere rerank could not be reached, timed out, or returned an unreadable response.", 502);
    }
    const results = payload && typeof payload === "object" && "results" in payload ? payload.results : null;
    if (!Array.isArray(results) || results.length !== candidates.length) {
      throw new KnowledgeError("INVALID_RERANK_RESPONSE", "Cohere rerank returned an incomplete candidate ranking.", 502);
    }
    const seen = new Set<number>();
    const ranked = results.map((result: unknown) => {
      if (!result || typeof result !== "object" || !("index" in result) || !("relevance_score" in result)
          || typeof result.index !== "number" || !Number.isInteger(result.index) || result.index < 0 || result.index >= candidates.length
          || seen.has(result.index) || typeof result.relevance_score !== "number" || !Number.isFinite(result.relevance_score)
          || result.relevance_score < 0 || result.relevance_score > 1) {
        throw new KnowledgeError("INVALID_RERANK_RESPONSE", "Cohere rerank returned invalid candidate indices or relevance scores.", 502);
      }
      seen.add(result.index);
      return { hit: { ...candidates[result.index], rerankScore: result.relevance_score }, index: result.index };
    });
    return ranked.sort((a, b) => b.hit.rerankScore - a.hit.rerankScore || a.index - b.index).map((item) => item.hit);
  };
}
