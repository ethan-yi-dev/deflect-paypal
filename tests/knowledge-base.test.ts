import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { assertBinding, getBinding, getProviderConfig, KnowledgeError } from "../lib/knowledge/config";
import type { Database, Sql } from "../lib/knowledge/database";
import { expectedDocumentHash, readDocumentSource } from "../lib/knowledge/document-http";
import { prepareFile, prepareText } from "../lib/knowledge/document-source";
import { chunkPages, createKnowledgeProviders, type KnowledgeProviders } from "../lib/knowledge/providers";
import { KnowledgeRepository } from "../lib/knowledge/repository";
import type { ModelBinding } from "../lib/knowledge/types";
import { processNextKnowledgeJob } from "../lib/knowledge/worker";

let pg: PGlite;
let db: Database;
const pdf = Buffer.from("%PDF-1.7\nTest PDF fixture\n%%EOF");
const values = () => [1, ...Array<number>(767).fill(0)];

before(async () => {
  pg = await PGlite.create({ extensions: { vector } });
  for (const name of (await readdir("db/migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    await pg.exec(await readFile(`db/migrations/${name}`, "utf8"));
  }
  db = {
    query: async <T extends object>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
    transaction: (work) => pg.transaction((tx) => work(async <T extends object>(text: string, params?: unknown[]) => (await tx.query<T>(text, params)).rows)),
  };
});
after(async () => { await pg?.close(); });

function repository() {
  return new KnowledgeRepository(db, { id: randomUUID(), embeddingModel: "gemini-embedding-2", embeddingDimensions: 768 });
}
function providers(overrides: Partial<KnowledgeProviders> = {}): KnowledgeProviders {
  return {
    parse: async () => [{ pageNumber: 1, text: "Returns are accepted within thirty days." }, { pageNumber: 2, text: "Shipping takes three business days." }],
    embed: async () => values(),
    ...overrides,
  };
}

test("PDF bytes persist in PostgreSQL as pending without creating a job", async () => {
  const repo = repository();
  const document = await repo.upload("policy.pdf", pdf);
  assert.equal(document.status, "pending");
  assert.equal(document.chunkCount, 0);
  assert.equal(document.embeddingModel, repo.binding.embeddingModel);
  assert.equal(document.contentHash, createHash("sha256").update(pdf).digest("hex"));
  assert.equal(document.sourceVersion, 1);
  assert.deepEqual(Buffer.from((await repo.pdf(document.id)).pdf_data), pdf);
  const [count] = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM t_knowledge_job WHERE doc_id=$1", [document.id]);
  assert.equal(count.count, 0);
  assert.equal((await repo.list()).documents[0].id, document.id);
});

test("upload rejects renamed non-PDF content and unsupported files", async () => {
  const repo = repository();
  await assert.rejects(repo.upload("policy.pdf", Buffer.from("This is not a PDF")), { code: "INVALID_PDF" });
  await assert.rejects(repo.upload("policy.docx", pdf), { code: "INVALID_DOCUMENT" });
  await assert.rejects(repo.upload("policy.pdf", new Uint8Array()), { code: "INVALID_DOCUMENT" });
});

test("concurrent CAS requests create exactly one running document and one queued job", async () => {
  const repo = repository();
  const document = await repo.upload("policy.pdf", pdf);
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => repo.startIndexing(document.id)));
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  for (const attempt of attempts) if (attempt.status === "rejected") assert.equal(attempt.reason.code, "ALREADY_RUNNING");
  const [jobs] = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM t_knowledge_job WHERE doc_id=$1", [document.id]);
  assert.equal(jobs.count, 1);
  assert.equal((await repo.list()).documents[0].status, "running");
});

test("failure to enqueue rolls the document CAS back to pending", async () => {
  const repo = repository();
  const document = await repo.upload("policy.pdf", pdf);
  const wrapped: Database = { ...db, transaction: (work) => db.transaction((sql) => {
    const failingSql: Sql = async (text, params) => {
      if (text.startsWith("INSERT INTO t_knowledge_job")) throw new Error("Queue write unavailable");
      return sql(text, params);
    };
    return work(failingSql);
  }) };
  await assert.rejects(new KnowledgeRepository(wrapped, repo.binding).startIndexing(document.id));
  assert.equal((await repo.list()).documents[0].status, "pending");
});

test("worker stores linked pgvector chunks and marks success; query excludes other bases", async () => {
  const repo = repository();
  const document = await repo.upload("policy.pdf", pdf);
  await repo.startIndexing(document.id);
  assert.equal(await processNextKnowledgeJob(repo, providers()), true);
  assert.equal(await processNextKnowledgeJob(repo, providers()), false);
  const [stored] = (await repo.list()).documents;
  assert.equal(stored.status, "success");
  assert.equal(stored.chunkCount, 2);
  assert.ok(stored.indexedAt);
  const chunks = await db.query<{ doc_id: string; dimensions: number }>("SELECT doc_id, vector_dims(embedding) AS dimensions FROM t_knowledge_chunk WHERE doc_id=$1", [document.id]);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].doc_id, document.id);
  assert.equal(chunks[0].dimensions, 768);
  const hits = await repo.search(values(), repo.binding, 5);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].docId, document.id);
  assert.equal(hits[0].score, 1);
  const other = repository();
  assert.deepEqual(await other.search(values(), other.binding, 5), []);
});

test("provider failure marks failed and permits a manual retry", async () => {
  const repo = repository();
  const document = await repo.upload("policy.pdf", pdf);
  await repo.startIndexing(document.id);
  await processNextKnowledgeJob(repo, providers({ parse: async () => { throw new KnowledgeError("PARSE_FAILED", "PDF parsing failed"); } }));
  let stored = (await repo.list()).documents[0];
  assert.equal(stored.status, "failed");
  assert.match(stored.errorMessage!, /PDF parsing failed/);
  const [failure] = await db.query<{ failed_step: string; error_stack: string }>("SELECT failed_step, error_stack FROM t_knowledge_job WHERE doc_id=$1 AND state='failed'", [document.id]);
  assert.equal(failure.failed_step, "parse");
  assert.match(failure.error_stack, /PDF parsing failed/);
  assert.equal((await repo.startIndexing(document.id)).status, "running");
  await processNextKnowledgeJob(repo, providers());
  stored = (await repo.list()).documents[0];
  assert.equal(stored.status, "success");
  assert.equal(stored.errorMessage, null);
});

test("reindexing deletes old vectors first; an embedding failure leaves no old or partial results", async () => {
  const repo = repository();
  const document = await repo.upload("policy.pdf", pdf);
  await repo.startIndexing(document.id);
  await processNextKnowledgeJob(repo, providers());
  await repo.startIndexing(document.id);
  let calls = 0;
  await processNextKnowledgeJob(repo, providers({ embed: async () => { if (++calls === 2) throw new Error("Embedding unavailable"); return values(); } }));
  assert.equal((await repo.list()).documents[0].status, "failed");
  assert.equal((await repo.search(values(), repo.binding, 5)).length, 0);
  const [old] = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM t_knowledge_chunk WHERE doc_id=$1", [document.id]);
  assert.equal(old.count, 0);
  await repo.startIndexing(document.id);
  await processNextKnowledgeJob(repo, providers({ parse: async () => [{ pageNumber: 3, text: "Updated policy." }] }));
  const hits = await repo.search(values(), repo.binding, 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].content, "Updated policy.");
  assert.equal(hits[0].pageNumber, 3);
});

test("expired jobs become failed, and an old worker cannot overwrite a retried job", async () => {
  const repo = repository();
  const document = await repo.upload("policy.pdf", pdf);
  await repo.startIndexing(document.id);
  const oldJob = (await repo.claimJob())!;
  assert.equal(await repo.claimJob(), null);
  await db.query("UPDATE t_knowledge_job SET lease_until=now() - interval '1 second' WHERE id=$1", [oldJob.id]);
  await assert.rejects(repo.renewLease(oldJob), { code: "JOB_LEASE_LOST" });
  await repo.recoverExpiredJobs();
  assert.equal((await repo.list()).documents[0].status, "failed");
  await repo.startIndexing(document.id);
  const newJob = (await repo.claimJob())!;
  await assert.rejects(repo.completeJob(oldJob, [{ pageNumber: 1, text: "Stale result", embedding: values() }]), { code: "STALE_JOB" });
  await repo.failJob(oldJob, "Old error");
  assert.equal((await repo.list()).documents[0].status, "running");
  await repo.completeJob(newJob, [{ pageNumber: 1, text: "Fresh result", embedding: values() }]);
  assert.equal((await repo.search(values(), repo.binding, 5))[0].content, "Fresh result");
});

test("model and dimensions are immutable and checked by indexing and query", async () => {
  const repo = repository();
  const document = await repo.upload("policy.pdf", pdf);
  await assert.rejects(db.query("UPDATE t_knowledge_base SET embedding_model='other-model' WHERE id=$1", [repo.binding.id]));
  const changed = new KnowledgeRepository(db, { ...repo.binding, embeddingModel: "gemini-embedding-001" });
  await assert.rejects(changed.startIndexing(document.id), { code: "EMBEDDING_MODEL_MISMATCH" });
  await assert.rejects(changed.search(values(), changed.binding, 5), { code: "EMBEDDING_MODEL_MISMATCH" });
  await assert.rejects(repo.search(values(), { ...repo.binding, embeddingDimensions: 1536 }, 5), { code: "EMBEDDING_MODEL_MISMATCH" });
  assert.throws(() => assertBinding(repo.binding, { ...repo.binding, embeddingModel: "other" }), { code: "EMBEDDING_MODEL_MISMATCH" });
});

test("wrong embedding dimensions fail without marking success or storing chunks", async () => {
  const repo = repository();
  const document = await repo.upload("policy.pdf", pdf);
  await repo.startIndexing(document.id);
  await processNextKnowledgeJob(repo, providers({ embed: async () => [1, 0, 0] }));
  assert.equal((await repo.list()).documents[0].status, "failed");
  assert.equal((await repo.search(values(), repo.binding, 5)).length, 0);
});

test("LlamaParse v2 uploads with Bearer auth and polls job.status for markdown pages", async () => {
  const binding = getBinding({});
  const urls: string[] = [];
  const responses = [
    { id: "file-id" }, { id: "job-id", status: "PENDING" },
    { job: { status: "RUNNING" } },
    { job: { status: "COMPLETED" }, markdown: { pages: [{ page_number: 2, markdown: "# Store policy", success: true }] } },
  ];
  const fetcher: typeof fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer llama-test-key");
    if (urls.length === 1) {
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get("purpose"), "parse");
    }
    if (urls.length === 2) assert.equal(JSON.parse(String(init?.body)).file_id, "file-id");
    return Response.json(responses.shift());
  };
  const api = createKnowledgeProviders(binding, { geminiKey: "gemini-test-key", llamaKey: "llama-test-key", tier: "agentic" }, fetcher, async () => {});
  assert.deepEqual(await api.parse(pdf, "policy.pdf", new AbortController().signal), [{ pageNumber: 2, text: "# Store policy" }]);
  assert.match(urls[0], /api\/v1\/beta\/files$/);
  assert.match(urls[3], /api\/v2\/parse\/job-id\?expand=markdown$/);
});

test("Gemini embedding uses the bound model, task prefixes, API key header, and output dimensions", async () => {
  const binding: ModelBinding = { id: "test", embeddingModel: "gemini-embedding-2", embeddingDimensions: 3 };
  const inputs: Record<string, unknown>[] = [];
  const api = createKnowledgeProviders(binding, { geminiKey: "gemini-test-key", llamaKey: "llama-test-key", tier: "agentic" }, async (url, init) => {
    assert.match(String(url), /models\/gemini-embedding-2:embedContent$/);
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "gemini-test-key");
    inputs.push(JSON.parse(String(init?.body)));
    return Response.json({ embedding: { values: [3, 4, 0] } });
  });
  assert.deepEqual(await api.embed("returns", "document", "policy.pdf", new AbortController().signal), [0.6, 0.8, 0]);
  await api.embed("return policy?", "query", "", new AbortController().signal);
  assert.equal(inputs[0].model, "models/gemini-embedding-2");
  assert.equal(inputs[0].outputDimensionality, 3);
  assert.match(JSON.stringify(inputs[0].content), /title: policy.pdf \| text: returns/);
  assert.match(JSON.stringify(inputs[1].content), /task: search result \| query: return policy/);
});

test("placeholder credentials are rejected and chunking retains page citations", () => {
  assert.throws(() => getProviderConfig({ GEMINI_API_KEY: "anyword", LLAMA_CLOUD_API_KEY: "anyword" }), { code: "PROVIDER_NOT_CONFIGURED" });
  const chunks = chunkPages([{ pageNumber: 4, text: "Return policy. ".repeat(1400) }]);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.pageNumber === 4 && chunk.text.trim()));
  assert.throws(() => chunkPages([{ pageNumber: 1, text: "" }]), { code: "EMPTY_DOCUMENT" });
});

test("identical content returns unchanged and preserves successful vectors, version, and timestamps", async () => {
  const repo = repository();
  const document = await repo.upload("policy.pdf", pdf);
  await repo.startIndexing(document.id);
  await processNextKnowledgeJob(repo, providers());
  const before = (await repo.list()).documents[0];
  const previousHits = await repo.search(values(), repo.binding, 5);
  const result = await repo.updateDocument(document.id, prepareFile("renamed.pdf", pdf), before.contentHash);
  assert.equal(result.changed, false);
  assert.equal(result.operation, "unchanged");
  assert.match(result.message, /No changes/);
  assert.deepEqual(result.document, before);
  assert.deepEqual(await repo.search(values(), repo.binding, 5), previousHits);
  const duplicate = await repo.createDocument(prepareFile("policy.pdf", pdf));
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.document.id, document.id);
  assert.equal((await repo.list()).documents.length, 1);
});

test("changed content keeps doc_id, increments version, and removes all vectors before rebuilding", async () => {
  const repo = repository();
  const original = await repo.upload("policy.pdf", pdf);
  await repo.startIndexing(original.id);
  await processNextKnowledgeJob(repo, providers());
  const changed = Buffer.from("%PDF-1.7\nNew delivery policy\n%%EOF");
  const result = await repo.updateDocument(original.id, prepareFile("policy.pdf", changed), original.contentHash);
  assert.equal(result.changed, true);
  assert.equal(result.document.id, original.id);
  assert.equal(result.document.sourceVersion, 2);
  assert.equal(result.document.status, "pending");
  assert.equal(result.document.chunkCount, 0);
  assert.equal(result.document.indexedAt, null);
  assert.notEqual(result.document.contentHash, original.contentHash);
  const [count] = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM t_knowledge_chunk WHERE doc_id=$1", [original.id]);
  assert.equal(count.count, 0);
  assert.equal((await repo.search(values(), repo.binding, 5)).length, 0);
  await repo.startIndexing(original.id);
  await processNextKnowledgeJob(repo, providers({ parse: async (bytes) => {
    assert.deepEqual(Buffer.from(bytes), changed);
    return [{ pageNumber: 1, text: "New delivery policy" }];
  } }));
  const hits = await repo.search(values(), repo.binding, 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].content, "New delivery policy");
  assert.equal(hits[0].docId, original.id);
});

test("identical running updates are no-ops; changed running updates are rejected", async () => {
  const repo = repository();
  const document = await repo.upload("policy.pdf", pdf);
  await repo.startIndexing(document.id);
  const result = await repo.updateDocument(document.id, prepareFile("policy.pdf", pdf), document.contentHash);
  assert.equal(result.changed, false);
  assert.equal(result.document.status, "running");
  await assert.rejects(repo.updateDocument(document.id, prepareFile("policy.pdf", Buffer.from("%PDF-1.7\nChanged")), document.contentHash), { code: "ALREADY_RUNNING" });
  const job = (await repo.claimJob())!;
  assert.deepEqual(Buffer.from((await repo.loadJobDocument(job)).pdf!), pdf);
});

test("stale browser hashes and concurrent conflicting updates cannot overwrite a newer version", async () => {
  const repo = repository();
  const document = await repo.upload("policy.pdf", pdf);
  const attempts = await Promise.allSettled([
    repo.updateDocument(document.id, prepareFile("policy.pdf", Buffer.from("%PDF-1.7\nVersion A")), document.contentHash),
    repo.updateDocument(document.id, prepareFile("policy.pdf", Buffer.from("%PDF-1.7\nVersion B")), document.contentHash),
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  const failed = attempts.find((item) => item.status === "rejected");
  assert.ok(failed?.status === "rejected");
  assert.equal(failed.reason.code, "DOCUMENT_CHANGED");
  assert.equal((await repo.list()).documents[0].sourceVersion, 2);
  const other = repository();
  await assert.rejects(other.updateDocument(document.id, prepareFile("policy.pdf", pdf), document.contentHash), { code: "DOCUMENT_NOT_FOUND" });
});

test("concurrent identical uploads produce one document, while changed same-name uploads require an ID update", async () => {
  const repo = repository();
  const results = await Promise.all(Array.from({ length: 6 }, () => repo.createDocument(prepareFile("policy.pdf", pdf))));
  assert.equal(results.filter((item) => item.operation === "created").length, 1);
  assert.equal(new Set(results.map((item) => item.document.id)).size, 1);
  await assert.rejects(repo.createDocument(prepareFile("policy.pdf", Buffer.from("%PDF-1.7\nDifferent"))), { code: "DOCUMENT_EXISTS" });
});

test("rejected replacement rolls back vector deletion and the original document", async () => {
  const repo = repository();
  const document = await repo.upload("policy.pdf", pdf);
  await repo.startIndexing(document.id);
  await processNextKnowledgeJob(repo, providers());
  const original = (await repo.list()).documents[0];
  const source = prepareFile("policy.pdf", Buffer.from("%PDF-1.7\nTampered hash"));
  await assert.rejects(repo.updateDocument(document.id, { ...source, hash: "0".repeat(64) }, document.contentHash));
  assert.deepEqual((await repo.list()).documents[0], original);
  assert.equal((await repo.search(values(), repo.binding, 5)).length, 2);
});

test("text and Markdown are hashed, stored, and embedded without calling LlamaParse", async () => {
  const repo = repository();
  const text = "# Shipping policy\n配送需要三个工作日。";
  const created = await repo.createDocument(prepareText("shipping.md", text));
  assert.equal(created.document.contentType, "text/markdown");
  assert.equal(created.document.contentHash, createHash("sha256").update(text).digest("hex"));
  assert.equal(Buffer.from((await repo.source(created.document.id)).source_data).toString("utf8"), text);
  await repo.startIndexing(created.document.id);
  await processNextKnowledgeJob(repo, providers({ parse: async () => { throw new Error("LlamaParse must not be called for text"); } }));
  assert.equal((await repo.list()).documents[0].status, "success");
  const hits = await repo.search(values(), repo.binding, 5);
  assert.equal(hits[0].content, text);
  assert.equal(hits[0].pageNumber, 1);
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("UTF-8 BOM text")]);
  const bom = await repo.createDocument(prepareFile("bom.txt", bytes));
  assert.equal(bom.document.contentHash, createHash("sha256").update(bytes).digest("hex"));
});

test("a worker cannot load or complete a job whose source hash differs from the document", async () => {
  const repo = repository();
  const document = await repo.upload("policy.pdf", pdf);
  await repo.startIndexing(document.id);
  const job = (await repo.claimJob())!;
  await db.query("UPDATE t_knowledge_job SET source_hash=$2 WHERE id=$1", [job.id, "0".repeat(64)]);
  await assert.rejects(repo.loadJobDocument(job), { code: "STALE_JOB" });
  await assert.rejects(repo.completeJob(job, [{ text: "Stale text", pageNumber: 1, embedding: values() }]), { code: "STALE_JOB" });
});

test("HTTP input accepts multipart and JSON text, requires current hashes, and rejects malformed content", async () => {
  const json = new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "policy", text: "Thirty day returns." }) });
  const source = await readDocumentSource(json);
  assert.equal(source.name, "policy.txt");
  assert.equal(source.text, "Thirty day returns.");
  const form = new FormData();
  form.set("file", new Blob([pdf], { type: "application/pdf" }), "policy.pdf");
  assert.equal((await readDocumentSource(new Request("http://localhost/api", { method: "POST", body: form }))).hash, createHash("sha256").update(pdf).digest("hex"));
  assert.equal(expectedDocumentHash(new Request("http://localhost/api", { headers: { "If-Match": `"${source.hash}"` } })), source.hash);
  assert.throws(() => expectedDocumentHash(new Request("http://localhost/api")), { code: "HASH_REQUIRED" });
  assert.throws(() => expectedDocumentHash(new Request("http://localhost/api", { headers: { "If-Match": "bad-hash" } })), { code: "INVALID_HASH" });
  assert.throws(() => prepareText("policy.txt", "   "), { code: "INVALID_TEXT" });
  assert.throws(() => prepareFile("bad.txt", Buffer.from([0xff, 0xfe])), { code: "INVALID_TEXT" });
  await assert.rejects(readDocumentSource(new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" })), { code: "INVALID_UPLOAD" });
});
