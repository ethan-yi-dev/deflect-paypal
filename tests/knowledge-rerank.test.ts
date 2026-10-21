import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getRerankConfig, KnowledgeError } from "../lib/knowledge/config";
import { createCohereReranker } from "../lib/knowledge/reranker";
import { retrieveKnowledge } from "../lib/knowledge/retrieval";
import type { ModelBinding, SearchHit } from "../lib/knowledge/types";

const binding: ModelBinding = { id: "test-base", embeddingModel: "gemini-embedding-2", embeddingDimensions: 3 };
const configured = () => getRerankConfig({ COHERE_API_KEY: "test-cohere-key" });
function candidates(): SearchHit[] {
  return Array.from({ length: 3 }, (_, index) => ({
    id: randomUUID(), docId: randomUUID(), documentName: `policy-${index}.pdf`,
    content: `Policy passage ${index}`, pageNumber: index + 1, score: 0.9 - index * 0.1,
  }));
}
function input() {
  const hits = candidates();
  const controller = new AbortController();
  const config = configured();
  return {
    query: "货没收到，哪些条款适用？", limit: 2, signal: controller.signal, config,
    repository: {
      binding,
      searchCandidates: async () => hits,
      retainSearchableHits: async (ranked: SearchHit[]) => ranked,
    },
    providers: { embed: async () => [1, 0, 0] },
    reranker: createCohereReranker(config, async () => Response.json({
      results: [{ index: 2, relevance_score: 0.95 }, { index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.1 }],
    })),
  };
}

test("rerank config defaults to 50 candidates and treats missing/placeholder keys as unconfigured", () => {
  const defaults = getRerankConfig({});
  assert.equal(defaults.model, "rerank-v4.0-fast");
  assert.equal(defaults.candidateCount, 50);
  assert.equal(defaults.timeoutMs, 10000);
  assert.equal(defaults.apiKey, null);
  assert.equal(getRerankConfig({ COHERE_API_KEY: " anyword " }).apiKey, null);
  assert.equal(getRerankConfig({ COHERE_API_KEY: " actual-key " }).apiKey, "actual-key");
  for (const env of [
    { KNOWLEDGE_RERANK_CANDIDATES: "19" }, { KNOWLEDGE_RERANK_CANDIDATES: "101" },
    { KNOWLEDGE_RERANK_CANDIDATES: "25.5" }, { KNOWLEDGE_RERANK_TIMEOUT_MS: "99" },
    { KNOWLEDGE_RERANK_TIMEOUT_MS: "60001" }, { COHERE_RERANK_MODEL: "gemini-embedding-2" },
  ]) assert.throws(() => getRerankConfig(env), { code: "INVALID_RERANK_CONFIG" });
});

test("Cohere v2 reranks the full candidate set, preserves cosine scores and citations, and maps indices safely", async () => {
  const hits = candidates();
  const reranker = createCohereReranker(configured(), async (url, init) => {
    assert.equal(String(url), "https://api.cohere.com/v2/rerank");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-cohere-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "rerank-v4.0-fast");
    assert.equal(body.query, "退款政策是什么？");
    assert.equal(body.top_n, hits.length);
    assert.deepEqual(body.documents.map((document: string) => JSON.parse(document)), hits.map((hit) => ({ title: hit.documentName, content: hit.content })));
    return Response.json({ results: [
      { index: 0, relevance_score: 0.2 }, { index: 2, relevance_score: 0.9 }, { index: 1, relevance_score: 0.2 },
    ] });
  });
  const ranked = await reranker("退款政策是什么？", hits, new AbortController().signal);
  assert.deepEqual(ranked, [{ ...hits[2], rerankScore: 0.9 }, { ...hits[0], rerankScore: 0.2 }, { ...hits[1], rerankScore: 0.2 }]);
  assert.ok(hits.every((hit) => hit.rerankScore === undefined));
});

test("invalid, incomplete, or duplicated reranker results cannot attach scores to the wrong chunks", async () => {
  const hits = candidates();
  const valid = [{ index: 0, relevance_score: 0.8 }, { index: 1, relevance_score: 0.5 }, { index: 2, relevance_score: 0.1 }];
  const malformed = [
    null, {}, { results: [] },
    { results: [{ ...valid[0], index: 99 }, valid[1], valid[2]] },
    { results: [valid[0], valid[0], valid[2]] },
    { results: [{ ...valid[0], index: -1 }, valid[1], valid[2]] },
    { results: [{ ...valid[0], index: 0.5 }, valid[1], valid[2]] },
    { results: [{ ...valid[0], relevance_score: "0.8" }, valid[1], valid[2]] },
    { results: [{ ...valid[0], relevance_score: 1.1 }, valid[1], valid[2]] },
    { results: [{ ...valid[0], relevance_score: -0.1 }, valid[1], valid[2]] },
  ];
  for (const payload of malformed) {
    const reranker = createCohereReranker(configured(), async () => Response.json(payload));
    await assert.rejects(reranker("query", hits, new AbortController().signal), { code: "INVALID_RERANK_RESPONSE" });
  }
});

test("reranker errors do not expose credentials, documents, or raw provider responses", async () => {
  const privateMessage = "secret-key and private document payload";
  const fetchers: typeof fetch[] = [
    async () => new Response(privateMessage, { status: 401 }),
    async () => { throw new Error(privateMessage); },
    async () => new Response(privateMessage, { status: 200 }),
  ];
  for (const fetcher of fetchers) {
    const reranker = createCohereReranker(configured(), fetcher);
    await assert.rejects(reranker("query", candidates(), new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.ok(!error.message.includes(privateMessage));
      assert.ok(!error.message.includes("test-cohere-key"));
      return true;
    });
  }
});

test("reranker timeout aborts its fetch and returns a sanitized unavailable error", async () => {
  const config = { ...configured(), timeoutMs: 100 };
  const reranker = createCohereReranker(config, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Request was not aborted")), 1000);
    init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
  }));
  await assert.rejects(reranker("query", candidates(), new AbortController().signal), { code: "RERANK_UNAVAILABLE" });
});

test("query retrieves more candidates than the final top K and uses the bound embedding model independently", async () => {
  const args = input();
  const original = await args.repository.searchCandidates();
  const calls: unknown[][] = [];
  const result = await retrieveKnowledge({ ...args,
    repository: { ...args.repository, searchCandidates: async (...parameters) => { calls.push(parameters); return original; } },
    providers: { embed: async (...parameters) => { calls.push(parameters); return [1, 0, 0]; } },
  });
  assert.deepEqual(calls[0].slice(0, 3), [args.query, "query", ""]);
  assert.deepEqual(calls[1], [[1, 0, 0], binding, 50]);
  assert.deepEqual(result.hits.map((hit) => hit.id), [original[2].id, original[0].id]);
  assert.equal(result.hits[0].score, original[2].score);
  assert.equal(result.hits[0].rerankScore, 0.95);
  assert.equal(result.knowledgeBase.embeddingModel, "gemini-embedding-2");
  assert.deepEqual(result.retrieval, { rerankStatus: "applied", rerankerModel: "rerank-v4.0-fast", candidateCount: 3, warning: null });
});

test("unconfigured reranking keeps vector search available and explicitly reports the fallback", async () => {
  const args = input();
  const hits = await args.repository.searchCandidates();
  const result = await retrieveKnowledge({ ...args, config: getRerankConfig({}), reranker: async () => { throw new Error("Must not call Cohere"); } });
  assert.deepEqual(result.hits, hits.slice(0, 2));
  assert.equal(result.retrieval.rerankStatus, "not_configured");
  assert.match(result.retrieval.warning!, /COHERE_API_KEY/);
  assert.equal(result.retrieval.rerankerModel, null);
});

test("provider failure falls back to vector order with a warning and without fake rerank scores", async () => {
  const args = input();
  const hits = await args.repository.searchCandidates();
  const result = await retrieveKnowledge({ ...args,
    reranker: createCohereReranker(configured(), async () => new Response("private provider details", { status: 429 })),
  });
  assert.deepEqual(result.hits, hits.slice(0, 2));
  assert.equal(result.retrieval.rerankStatus, "unavailable");
  assert.match(result.retrieval.warning!, /HTTP 429.*vector similarity/);
  assert.ok(!result.retrieval.warning!.includes("private provider details"));
  assert.ok(result.hits.every((hit) => hit.rerankScore === undefined));
});

test("empty retrieval skips reranking and returns no hits", async () => {
  const args = input();
  const result = await retrieveKnowledge({ ...args,
    repository: { ...args.repository, searchCandidates: async () => [] },
    reranker: async () => { throw new Error("Must not rerank an empty candidate set"); },
  });
  assert.deepEqual(result.hits, []);
  assert.equal(result.retrieval.rerankStatus, "empty");
});

test("final eligibility filtering runs over the whole ranking before taking top K", async () => {
  const args = input();
  const original = await args.repository.searchCandidates();
  const result = await retrieveKnowledge({ ...args,
    repository: { ...args.repository, retainSearchableHits: async (ranked) => ranked.filter((hit) => hit.id !== original[2].id) },
  });
  assert.deepEqual(result.hits.map((hit) => hit.id), [original[0].id, original[1].id]);
  assert.equal(result.hits.length, 2);
});

test("caller cancellation propagates instead of returning fallback results", async () => {
  const args = input();
  const controller = new AbortController();
  await assert.rejects(retrieveKnowledge({ ...args, signal: controller.signal,
    reranker: async (_query, _hits, signal) => { controller.abort(); signal.throwIfAborted(); return []; },
  }), { name: "AbortError" });
});

test("invalid final limits are rejected before making embedding or reranking calls", async () => {
  const args = input();
  await assert.rejects(retrieveKnowledge({ ...args, limit: 21,
    providers: { embed: async () => { throw new Error("Must not embed invalid input"); } },
  }), { code: "INVALID_LIMIT" });
});
