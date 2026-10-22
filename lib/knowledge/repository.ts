import { randomUUID } from "node:crypto";
import { assertBinding, KnowledgeError } from "./config";
import type { Database, Sql } from "./database";
import { prepareFile, type DocumentSource } from "./document-source";
import type { ActiveProcessing, KnowledgeChunk, KnowledgeContentType, KnowledgeDeleteResult, KnowledgeDocument, KnowledgeList, KnowledgeStatus, KnowledgeWriteResult, ModelBinding, ProcessingStage, SearchHit } from "./types";

type DocumentRow = {
  id: string; name: string; size: number; status: KnowledgeStatus; embedding_model: string;
  chunk_count: number; error_message: string | null; created_at: Date | string; indexed_at: Date | string | null;
  content_type: KnowledgeContentType; content_hash: string; source_version: number; updated_at: Date | string;
};
const documentColumns = "id, name, size, status, embedding_model, chunk_count, error_message, created_at, indexed_at, content_type, content_hash, source_version, updated_at";
function documentDto(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id, name: row.name, size: row.size, status: row.status, embeddingModel: row.embedding_model,
    chunkCount: row.chunk_count, errorMessage: row.error_message,
    contentType: row.content_type, contentHash: row.content_hash, sourceVersion: row.source_version, updatedAt: new Date(row.updated_at).toISOString(),
    uploadedAt: new Date(row.created_at).toISOString(), indexedAt: row.indexed_at ? new Date(row.indexed_at).toISOString() : null,
  };
}
export type ProcessingRun = { id: string; docId: string };

export function validateVector(vector: number[], dimensions: number) {
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)) || !vector.some((value) => value !== 0)) {
    throw new KnowledgeError("INVALID_EMBEDDING", "The embedding response has invalid values or dimensions.", 502);
  }
}

export class KnowledgeRepository {
  constructor(public db: Database, public binding: ModelBinding) {}

  async ensureBase(sql: Sql = this.db.query) {
    const b = this.binding;
    await sql("INSERT INTO t_knowledge_base (id, embedding_model, embedding_dimensions) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING", [b.id, b.embeddingModel, b.embeddingDimensions]);
    const [base] = await sql<{ id: string; embedding_model: string; embedding_dimensions: number }>("SELECT * FROM t_knowledge_base WHERE id=$1", [b.id]);
    assertBinding({ id: base.id, embeddingModel: base.embedding_model, embeddingDimensions: base.embedding_dimensions }, b);
    return b;
  }

  async list(): Promise<KnowledgeList> {
    const knowledgeBase = await this.ensureBase();
    await this.recoverExpiredJobs();
    const rows = await this.db.query<DocumentRow>(`SELECT ${documentColumns} FROM t_knowledge_document WHERE knowledge_base_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC, id`, [knowledgeBase.id]);
    // Include a removed document's active attempt until it settles or expires.
    const [activeProcessing] = await this.db.query<ActiveProcessing>(`SELECT d.id AS "documentId", d.name AS "documentName",
      j.stage, j.completed_chunks AS "completedChunks", j.total_chunks AS "totalChunks"
      FROM t_knowledge_job j JOIN t_knowledge_document d ON d.id=j.doc_id
      WHERE d.knowledge_base_id=$1 AND j.state='working' ORDER BY j.created_at LIMIT 1`, [knowledgeBase.id]);
    return { knowledgeBase, documents: rows.map(documentDto), activeProcessing: activeProcessing ?? null };
  }

  async document(docId: string) {
    const [row] = await this.db.query<DocumentRow>(`SELECT ${documentColumns} FROM t_knowledge_document WHERE id=$1 AND knowledge_base_id=$2 AND deleted_at IS NULL`, [docId, this.binding.id]);
    if (!row) throw new KnowledgeError("DOCUMENT_NOT_FOUND", "Document not found.", 404);
    return documentDto(row);
  }

  async upload(name: string, pdf: Uint8Array) {
    return (await this.createDocument(prepareFile(name, pdf))).document;
  }

  async createDocument(source: DocumentSource): Promise<KnowledgeWriteResult> {
    return this.db.transaction(async (sql) => {
      const b = await this.ensureBase(sql);
      const [row] = await sql<DocumentRow>(`INSERT INTO t_knowledge_document
        (id, knowledge_base_id, name, size, pdf_data, text_content, content_type, content_hash, embedding_model, embedding_dimensions)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (knowledge_base_id, name) WHERE deleted_at IS NULL DO NOTHING RETURNING ${documentColumns}`,
      [randomUUID(), b.id, source.name, source.size, source.pdf, source.text, source.contentType, source.hash, b.embeddingModel, b.embeddingDimensions]);
      if (row) return { document: documentDto(row), changed: true, operation: "created", message: "Document uploaded as pending." };
      const [existing] = await sql<DocumentRow>(`SELECT ${documentColumns} FROM t_knowledge_document WHERE knowledge_base_id=$1 AND name=$2 AND deleted_at IS NULL FOR UPDATE`, [b.id, source.name]);
      if (!existing) throw new KnowledgeError("DOCUMENT_CHANGED", "This document was removed during upload. Try uploading it again.", 409);
      if (existing.content_hash === source.hash) return { document: documentDto(existing), changed: false, operation: "unchanged", message: "No changes. Existing content and vectors were kept." };
      throw new KnowledgeError("DOCUMENT_EXISTS", "A document with this name already exists. Use its Update action to replace it by document ID.", 409);
    });
  }

  async updateDocument(docId: string, source: DocumentSource, expectedHash: string): Promise<KnowledgeWriteResult> {
    return this.db.transaction(async (sql) => {
      const b = await this.ensureBase(sql);
      const [existing] = await sql<DocumentRow>(`SELECT ${documentColumns} FROM t_knowledge_document WHERE id=$1 AND knowledge_base_id=$2 AND deleted_at IS NULL FOR UPDATE`, [docId, b.id]);
      if (!existing) throw new KnowledgeError("DOCUMENT_NOT_FOUND", "Document not found.", 404);
      // An identical upload is a no-op even while indexing; it must not alter the job.
      if (existing.content_hash === source.hash) return { document: documentDto(existing), changed: false, operation: "unchanged", message: "No changes. Existing content and vectors were kept." };
      if (existing.status === "running") throw new KnowledgeError("ALREADY_RUNNING", "This document is running. Wait for indexing to finish before updating it.", 409);
      if (existing.content_hash !== expectedHash) throw new KnowledgeError("DOCUMENT_CHANGED", "This document changed since you opened it. Refresh and review the latest version before updating.", 409);
      // Preserve document identity; full replacement removes old vectors first.
      await sql("DELETE FROM t_knowledge_chunk WHERE doc_id=$1", [docId]);
      const [row] = await sql<DocumentRow>(`UPDATE t_knowledge_document SET size=$3, pdf_data=$4, text_content=$5,
        content_type=$6, content_hash=$7, source_version=source_version+1, status='pending', active_run_id=NULL,
        chunk_count=0, indexed_at=NULL, error_message=NULL, updated_at=now(), name=$8
        WHERE id=$1 AND knowledge_base_id=$2 RETURNING ${documentColumns}`,
      [docId, b.id, source.size, source.pdf, source.text, source.contentType, source.hash, source.name]);
      return { document: documentDto(row), changed: true, operation: "updated", message: "Document updated. Old vectors were removed. Click Process document to rebuild the index." };
    });
  }

  async deleteDocument(docId: string): Promise<KnowledgeDeleteResult> {
    const [row] = await this.db.query<{ id: string; deleted_at: Date | string }>(`UPDATE t_knowledge_document
      SET deleted_at=COALESCE(deleted_at, now()), updated_at=CASE WHEN deleted_at IS NULL THEN now() ELSE updated_at END
      WHERE id=$1 AND knowledge_base_id=$2 RETURNING id, deleted_at`, [docId, this.binding.id]);
    if (!row) throw new KnowledgeError("DOCUMENT_NOT_FOUND", "Document not found.", 404);
    return { id: row.id, deletedAt: new Date(row.deleted_at).toISOString(), message: "Document removed from the knowledge base. Its source, chunks, and vectors are retained and excluded from search." };
  }

  async startProcessing(docId: string) {
    await this.ensureBase();
    await this.recoverExpiredJobs();
    return this.db.transaction(async (sql) => {
      const b = await this.ensureBase(sql);
      // Serialize admission across documents, browser tabs, and server instances.
      // This short transaction ends before any external provider is called.
      await sql("SELECT id FROM t_knowledge_base WHERE id=$1 FOR UPDATE", [b.id]);
      const [existing] = await sql<DocumentRow>(`SELECT ${documentColumns} FROM t_knowledge_document WHERE id=$1 AND knowledge_base_id=$2 AND deleted_at IS NULL FOR UPDATE`, [docId, b.id]);
      if (!existing) throw new KnowledgeError("DOCUMENT_NOT_FOUND", "Document not found.", 404);
      if (existing.status === "running") throw new KnowledgeError("ALREADY_RUNNING", "This document is already processing. Wait for it to succeed or fail.", 409);
      const active = await sql(`SELECT j.id FROM t_knowledge_job j JOIN t_knowledge_document d ON d.id=j.doc_id
        WHERE d.knowledge_base_id=$1 AND j.state='working' LIMIT 1`, [b.id]);
      if (active.length) throw new KnowledgeError("PROCESSING_BUSY", "Another document is processing. Wait for it to succeed or fail before starting this document.", 409);
      const runId = randomUUID();
      // Atomic CAS: concurrent requests recheck this predicate after row-lock waits.
      const [row] = await sql<DocumentRow>(`UPDATE t_knowledge_document SET status='running', active_run_id=$3,
        error_message=NULL, chunk_count=0, indexed_at=NULL, updated_at=now() WHERE id=$1 AND knowledge_base_id=$2 AND deleted_at IS NULL AND status <> 'running'
        AND embedding_model=$4 AND embedding_dimensions=$5 RETURNING ${documentColumns}`,
      [docId, b.id, runId, b.embeddingModel, b.embeddingDimensions]);
      if (!row) {
        const existing = await sql("SELECT id FROM t_knowledge_document WHERE id=$1 AND knowledge_base_id=$2 AND deleted_at IS NULL", [docId, b.id]);
        throw new KnowledgeError(existing.length ? "ALREADY_RUNNING" : "DOCUMENT_NOT_FOUND", existing.length ? "This document is already running. Wait for it to finish." : "Document not found.", existing.length ? 409 : 404);
      }
      // The selected document starts immediately; nothing is queued for later.
      await sql("DELETE FROM t_knowledge_chunk WHERE doc_id=$1", [docId]);
      await sql(`INSERT INTO t_knowledge_job (id, doc_id, source_hash, state, lease_until, stage)
        VALUES ($1,$2,$3,'working',now() + interval '2 minutes','load')`, [runId, docId, row.content_hash]);
      return { document: documentDto(row), run: { id: runId, docId } };
    });
  }

  async updateProgress(job: ProcessingRun, stage: ProcessingStage, completedChunks = 0, totalChunks = 0) {
    const rows = await this.db.query(`UPDATE t_knowledge_job j SET stage=$3, completed_chunks=$4, total_chunks=$5
      WHERE j.id=$1 AND j.doc_id=$2 AND j.state='working' AND j.lease_until > now()
      AND EXISTS (SELECT 1 FROM t_knowledge_document d WHERE d.id=j.doc_id AND d.active_run_id=j.id
        AND d.knowledge_base_id=$6 AND d.deleted_at IS NULL AND d.content_hash=j.source_hash)
      RETURNING j.id`, [job.id, job.docId, stage, completedChunks, totalChunks, this.binding.id]);
    if (!rows.length) throw new KnowledgeError("STALE_JOB", "This processing attempt is no longer active.", 409);
  }

  async renewLease(job: ProcessingRun) {
    const rows = await this.db.query(`UPDATE t_knowledge_job SET lease_until=now() + interval '2 minutes'
      WHERE id=$1 AND state='working' AND lease_until > now()
      AND EXISTS (SELECT 1 FROM t_knowledge_document d WHERE d.id=t_knowledge_job.doc_id AND d.deleted_at IS NULL)
      RETURNING id`, [job.id]);
    if (!rows.length) throw new KnowledgeError("JOB_LEASE_LOST", "The processing request stopped or expired. Retry processing.", 409);
  }

  async loadJobDocument(job: ProcessingRun) {
    await this.ensureBase();
    const [row] = await this.db.query<{ name: string; pdf_data: Uint8Array | null; text_content: string | null; content_type: KnowledgeContentType; embedding_model: string; embedding_dimensions: number }>(`SELECT d.name, d.pdf_data, d.text_content, d.content_type, d.embedding_model, d.embedding_dimensions FROM t_knowledge_document d JOIN t_knowledge_job j ON j.id=d.active_run_id
      WHERE d.id=$1 AND d.active_run_id=$2 AND d.status='running' AND d.deleted_at IS NULL AND d.knowledge_base_id=$3 AND j.source_hash=d.content_hash
      AND j.state='working' AND j.lease_until > now()`, [job.docId, job.id, this.binding.id]);
    if (!row) throw new KnowledgeError("STALE_JOB", "This indexing attempt is no longer active.", 409);
    assertBinding({ id: this.binding.id, embeddingModel: row.embedding_model, embeddingDimensions: row.embedding_dimensions }, this.binding);
    return { name: row.name, pdf: row.pdf_data, text: row.text_content, contentType: row.content_type };
  }

  async completeJob(job: ProcessingRun, chunks: KnowledgeChunk[]) {
    if (!chunks.length) throw new KnowledgeError("EMPTY_DOCUMENT", "No searchable text was found in this document.", 422);
    for (const chunk of chunks) validateVector(chunk.embedding, this.binding.embeddingDimensions);
    await this.db.transaction(async (sql) => {
      const b = await this.ensureBase(sql);
      const [lease] = await sql<{ source_hash: string }>("SELECT source_hash FROM t_knowledge_job WHERE id=$1 AND state='working' AND lease_until > now() FOR UPDATE", [job.id]);
      const active = await sql("SELECT id FROM t_knowledge_document WHERE id=$1 AND active_run_id=$2 AND status='running' AND deleted_at IS NULL AND knowledge_base_id=$3 AND content_hash=$4 FOR UPDATE", [job.docId, job.id, b.id, lease?.source_hash ?? ""]);
      if (!lease || !active.length) throw new KnowledgeError("STALE_JOB", "A stale processing request cannot overwrite this document.", 409);
      await sql("DELETE FROM t_knowledge_chunk WHERE doc_id=$1", [job.docId]);
      for (const [index, chunk] of chunks.entries()) {
        await sql(`INSERT INTO t_knowledge_chunk (id, doc_id, knowledge_base_id, chunk_index, content, page_number, embedding_model, embedding_dimensions, embedding)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector)`,
        [randomUUID(), job.docId, b.id, index, chunk.text, chunk.pageNumber, b.embeddingModel, b.embeddingDimensions, JSON.stringify(chunk.embedding)]);
      }
      await sql("UPDATE t_knowledge_document SET status='success', active_run_id=NULL, chunk_count=$3, indexed_at=now(), updated_at=now(), error_message=NULL WHERE id=$1 AND active_run_id=$2", [job.docId, job.id, chunks.length]);
      await sql("UPDATE t_knowledge_job SET state='done', stage='store', completed_chunks=$2, total_chunks=$2, lease_until=NULL, finished_at=now() WHERE id=$1", [job.id, chunks.length]);
    });
  }

  async failJob(job: ProcessingRun, message: string, failure?: { step: string; stack: string }) {
    await this.db.transaction(async (sql) => {
      const rows = await sql("UPDATE t_knowledge_job SET state='failed', lease_until=NULL, error_message=$2, failed_step=$3, error_stack=$4, finished_at=now() WHERE id=$1 AND state='working' RETURNING id", [job.id, message.slice(0, 1000), failure?.step ?? null, failure?.stack.slice(0, 8000) ?? null]);
      if (rows.length) await sql("UPDATE t_knowledge_document SET status='failed', active_run_id=NULL, error_message=$3, updated_at=now() WHERE id=$1 AND active_run_id=$2 AND status='running'", [job.docId, job.id, message.slice(0, 1000)]);
    });
  }

  async recoverExpiredJobs() {
    await this.db.transaction(async (sql) => {
      const expired = await sql<{ id: string; doc_id: string }>(`SELECT j.id, j.doc_id FROM t_knowledge_job j JOIN t_knowledge_document d ON d.id=j.doc_id
        WHERE d.knowledge_base_id=$1 AND (j.state='queued' OR (j.state='working' AND (j.lease_until <= now() OR j.stage IS NULL)))
        FOR UPDATE OF j SKIP LOCKED`, [this.binding.id]);
      for (const job of expired) {
        const message = "The processing request stopped or expired. Click Retry processing to start again.";
        await sql("UPDATE t_knowledge_job SET state='failed', lease_until=NULL, error_message=$2, failed_step=COALESCE(stage, 'load'), finished_at=now() WHERE id=$1", [job.id, message]);
        await sql("UPDATE t_knowledge_document SET status='failed', active_run_id=NULL, error_message=$3, updated_at=now() WHERE id=$1 AND active_run_id=$2", [job.doc_id, job.id, message]);
      }
    });
  }

  async pdf(docId: string) {
    const [row] = await this.db.query<{ name: string; pdf_data: Uint8Array }>("SELECT name, pdf_data FROM t_knowledge_document WHERE id=$1 AND knowledge_base_id=$2 AND deleted_at IS NULL", [docId, this.binding.id]);
    if (!row) throw new KnowledgeError("DOCUMENT_NOT_FOUND", "Document not found.", 404);
    return row;
  }

  async source(docId: string) {
    const [row] = await this.db.query<{ name: string; content_type: KnowledgeContentType; source_data: Uint8Array }>(`SELECT name, content_type, COALESCE(pdf_data, convert_to(text_content, 'UTF8')) AS source_data
      FROM t_knowledge_document WHERE id=$1 AND knowledge_base_id=$2 AND deleted_at IS NULL`, [docId, this.binding.id]);
    if (!row) throw new KnowledgeError("DOCUMENT_NOT_FOUND", "Document not found.", 404);
    return row;
  }

  async search(vector: number[], requestedBinding: ModelBinding, limit: number): Promise<SearchHit[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new KnowledgeError("INVALID_LIMIT", "Search limit must be between 1 and 20.", 400);
    return this.searchCandidates(vector, requestedBinding, limit);
  }

  async searchCandidates(vector: number[], requestedBinding: ModelBinding, limit: number): Promise<SearchHit[]> {
    const b = await this.ensureBase();
    assertBinding(requestedBinding, b);
    validateVector(vector, b.embeddingDimensions);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new KnowledgeError("INVALID_CANDIDATE_LIMIT", "Retrieve between 1 and 100 candidates.", 400);
    // The dimension interpolation is a validated integer; all user data remains parameterized.
    const expression = b.embeddingDimensions === 768 ? "c.embedding::vector(768)" : "c.embedding";
    return this.db.transaction(async (sql) => {
      // pgvector >= 0.8.0: keep scanning when retained soft-deleted chunks or
      // other base/model filters eliminate early HNSW matches. Settings stay local.
      await sql("SET LOCAL hnsw.iterative_scan = 'strict_order'");
      await sql(`SET LOCAL hnsw.ef_search = ${Math.max(40, limit * 2)}`);
      return sql<SearchHit>(`SELECT c.id, c.doc_id AS "docId", d.name AS "documentName", c.content,
        c.page_number AS "pageNumber", 1 - (${expression} <=> $1::vector) AS score
        FROM t_knowledge_chunk c JOIN t_knowledge_document d ON d.id=c.doc_id
        WHERE c.knowledge_base_id=$2 AND c.embedding_model=$3 AND c.embedding_dimensions=$4
        ${b.embeddingDimensions === 768 ? "AND c.embedding_dimensions=768" : ""}
        AND d.status='success' AND d.deleted_at IS NULL AND d.embedding_model=$3 AND d.embedding_dimensions=$4
        ORDER BY ${expression} <=> $1::vector LIMIT $5`, [JSON.stringify(vector), b.id, b.embeddingModel, b.embeddingDimensions, limit]);
    });
  }

  async retainSearchableHits(hits: SearchHit[]): Promise<SearchHit[]> {
    if (!hits.length) return [];
    const b = this.binding;
    const rows = await this.db.query<{ id: string }>(`SELECT c.id FROM t_knowledge_chunk c JOIN t_knowledge_document d ON d.id=c.doc_id
      WHERE c.id=ANY($1::uuid[]) AND c.knowledge_base_id=$2 AND c.embedding_model=$3 AND c.embedding_dimensions=$4
      AND d.status='success' AND d.deleted_at IS NULL AND d.embedding_model=$3 AND d.embedding_dimensions=$4`,
    [hits.map((hit) => hit.id), b.id, b.embeddingModel, b.embeddingDimensions]);
    const eligible = new Set(rows.map((row) => row.id));
    return hits.filter((hit) => eligible.has(hit.id));
  }
}
