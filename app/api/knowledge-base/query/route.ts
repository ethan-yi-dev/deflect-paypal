import { assertBinding, getProviderConfig, getRerankConfig, KnowledgeError } from "@/lib/knowledge/config";
import { createKnowledgeProviders } from "@/lib/knowledge/providers";
import { createCohereReranker } from "@/lib/knowledge/reranker";
import { retrieveKnowledge } from "@/lib/knowledge/retrieval";
import { knowledgeErrorResponse, knowledgeHeaders, knowledgeRepository, requireSameOrigin } from "@/lib/knowledge/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const raw = await request.text();
    if (raw.length > 16000) throw new KnowledgeError("QUERY_TOO_LARGE", "Keep the query within 2000 characters.", 413);
    let input;
    try { input = JSON.parse(raw) as { query?: unknown; embeddingModel?: unknown; limit?: unknown }; }
    catch { throw new KnowledgeError("INVALID_QUERY", "Send a JSON query.", 400); }
    if (!input || typeof input.query !== "string" || !input.query.trim() || input.query.length > 2000) throw new KnowledgeError("INVALID_QUERY", "Enter a query between 1 and 2000 characters.", 400);
    const limit = input.limit ?? 5;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new KnowledgeError("INVALID_LIMIT", "Search limit must be between 1 and 20.", 400);
    const repository = knowledgeRepository();
    const binding = await repository.ensureBase();
    if (input.embeddingModel !== undefined) {
      if (typeof input.embeddingModel !== "string") throw new KnowledgeError("INVALID_QUERY", "embeddingModel must be a string.", 400);
      assertBinding({ ...binding, embeddingModel: input.embeddingModel }, binding);
    }
    const config = getRerankConfig();
    const result = await retrieveKnowledge({
      query: input.query.trim(), limit, signal: request.signal, repository, config,
      providers: createKnowledgeProviders(binding, getProviderConfig()), reranker: createCohereReranker(config),
    });
    return Response.json(result, { headers: knowledgeHeaders });
  } catch (error) { return knowledgeErrorResponse(error); }
}
