# Knowledge base

The knowledge base is shared by the live and demo workspaces. PDF/text sources, metadata,
chunks, vectors, and jobs all persist in PostgreSQL. No object store, separate
vector database, Redis service, or browser storage is required.

## Setup

1. Install dependencies with `npm install`.
2. Add the values in [`.env.example`](../.env.example) to your existing `.env.local`.
   Keep the existing PayPal credentials. Replace `anyword` API keys with real keys.
3. Start a PostgreSQL server with pgvector 0.8.0 or newer installed. If Docker is available, the
   supplied development server can be started with:

   ```sh
   docker compose up -d postgres
   ```

   Its URL is `postgresql://deflect:anyword@localhost:5432/deflect`. For an existing
   PostgreSQL server, supply its `DATABASE_URL` instead. The database user must be
   able to create tables, functions, indexes, and the `vector` extension during
   migration (or have an administrator install the extension beforehand).

4. Initialize the schema:

   ```sh
   npm run db:migrate
   ```

5. Start the app and worker in separate terminals:

   ```sh
   npm run dev
   ```

   ```sh
   npm run worker:knowledge
   ```

   Production uses `npm run build` and `npm run start`, with the worker running
   separately under your process supervisor. Additional worker processes can
   consume different jobs through PostgreSQL `FOR UPDATE SKIP LOCKED`.

Open **Customize Your own knowledge base**. Upload PDF/TXT/MD files or select
**Paste text**, then click **Start chunking**. The worker calls LlamaParse for PDFs
and Google for embeddings; saving a source does not invoke paid providers.
Click a document name to download its
stored original. **Search your knowledge** returns matching chunks and page
citations; it does not generate an LLM answer or change dispute recommendations.
Search first retrieves vector candidates, then uses Cohere to rerank them when
`COHERE_API_KEY` is configured. No embedding rebuild is required to enable reranking.

## Configuration and model binding

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection URL; honors node-postgres SSL connection options. |
| `KNOWLEDGE_BASE_ID` | Defaults to `default`. A different ID creates a separate knowledge base on first use. |
| `GEMINI_API_KEY` | Google AI Studio key, sent only on the server in `x-goog-api-key`. |
| `GEMINI_EMBEDDING_MODEL` | Defaults to `gemini-embedding-2`; also supports `gemini-embedding-001`. |
| `GEMINI_EMBEDDING_DIMENSIONS` | Defaults to `768`; integer from 1 to 3072. |
| `LLAMA_CLOUD_API_KEY` | LlamaParse key, sent only on the server in `Authorization: Bearer ...`. |
| `LLAMA_PARSE_TIER` | Defaults to `agentic`; also supports `fast`, `cost_effective`, and `agentic_plus`. |
| `COHERE_API_KEY` | Cohere key, sent only on the server as `Authorization: Bearer ...`. Missing or `anyword` falls back to vector ordering with a visible warning. |
| `COHERE_RERANK_MODEL` | Defaults to the multilingual `rerank-v4.0-fast`; independent of the bound embedding model. |
| `KNOWLEDGE_RERANK_CANDIDATES` | Internal vector candidate count, defaults to `50`; integer from 20 to 100. Separate from the final query `limit`. |
| `KNOWLEDGE_RERANK_TIMEOUT_MS` | Cohere request timeout including response parsing, defaults to `10000`; integer from 100 to 60000. |

The first use binds `embedding_model` and `embedding_dimensions` to
`t_knowledge_base`. A database trigger forbids changing that binding. Documents
and chunks carry the same values, protected by composite foreign keys. Indexing
and query compare their runtime configuration to the stored binding before
calling providers. Returned vectors must have exactly the bound dimensions.
Changing the environment model or dimensions for an existing base produces a
409 error rather than mixing incompatible embeddings. To migrate, select a new
`KNOWLEDGE_BASE_ID`, upload the originals there, and index them again.

The default 768-dimensional vectors use a partial HNSW cosine index. Other
dimensions use exact cosine search; add a matching expression/partial index if
needed. Model 2 uses Google's retrieval prompt formats; model 001 uses
`RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`. Vectors are normalized before storage.

## Tables

Schema: [`001_knowledge_base.sql`](../db/migrations/001_knowledge_base.sql),
[`002_document_hash_updates.sql`](../db/migrations/002_document_hash_updates.sql), and
[`003_document_soft_delete.sql`](../db/migrations/003_document_soft_delete.sql).
`npm run db:migrate` applies all numbered migrations in order. They are repeatable;
the hash migration backfills existing PDFs without deleting their contents. Existing
duplicate names within one base must be resolved before adding the unique name index.

| Table | Stores |
| --- | --- |
| `t_knowledge_base` | Knowledge-base identity and immutable embedding model/dimension binding. |
| `t_knowledge_document` | Original PDF in `pdf_data bytea` or UTF-8 text in `text_content`; content type, SHA-256 `content_hash`, `source_version`, processing status, binding, timestamps, chunk count, and nullable `deleted_at` for soft deletion. |
| `t_knowledge_chunk` | Chunk text, page, sequence, pgvector embedding, model binding; `doc_id` references the document. |
| `t_knowledge_job` | Durable queued/working/done/failed attempts, source hash snapshot, and worker leases. |

The source limit is 50 MiB. Files may be PDF, UTF-8 TXT, or UTF-8 Markdown.
The API enforces streamed request size, source size, PDF signatures, and text encoding;
the database checks byte length, source shape, and the SHA-256 against the stored bytes.
Multi-file uploads are sent one at a time, and successful files are removed
from the selection even if another file fails. Failed selections remain available
for retry. The supplied app uses one configured base; it has no user/tenant
authentication layer.

## State machine and transaction guarantees

```text
Upload -> pending
User starts indexing -> running (queued, then consumed by a worker)
Parse -> Chunk -> Embed -> Store -> success
Any processing error -> failed
Changed update -> pending (old vectors removed)
Unchanged update -> no state change
User retries/reindexes -> running (old vectors removed)
```

The trigger endpoint uses an atomic conditional `UPDATE`:

```sql
UPDATE t_knowledge_document
SET status = 'running', active_run_id = :new_run_id
WHERE id = :doc_id AND status <> 'running'
RETURNING id;
```

The actual statement also scopes the base, requires `deleted_at IS NULL`, and checks the model binding. Exactly
one concurrent request wins. A request that finds the document already running
returns 409. The status update, removal of old vectors, and job insert commit in
the same transaction; a queue write failure rolls everything back. Uploads and
updates do not automatically queue jobs.

The worker renews its two-minute lease every 30 seconds. A worker that loses its
lease cannot commit results. Any active worker recovers expired jobs as `failed`,
making them available for manual retry. Jobs that are queued while all workers
are stopped remain durable and are consumed when a worker starts.

LlamaParse v2 uploads the original PDF, starts a parse job, and polls `job.status`
until `COMPLETED`. Parsed Markdown pages are chunked with LlamaIndex's
`SentenceSplitter` (512 tokens, 64-token overlap), preserving page citations.
LlamaParse's parse API itself returns parsed content; it does not expose an
independent chunk endpoint. No LlamaCloud hosted index/vector store is created.
Each chunk then gets a Google embedding. Provider request timeouts are 60 seconds;
the parse polling deadline is 15 minutes. Text/Markdown sources skip LlamaParse
and go directly to the same chunking and embedding steps, with page number 1.

Full replacement deletes old chunks/vectors before new processing begins. New
chunks are prepared in memory, then inserted together with the `success` state
in one transaction. Failed processing leaves no previous or partial vectors.
The active run ID, source hash snapshot, and live worker lease fence the final
write, so stale workers cannot overwrite a newer source or retried job. Pending,
failed, running, and soft-deleted documents are excluded from retrieval.

## Updating documents and checking SHA-256

Use **Update** on a document row to target its existing `doc_id`. Choose one new
PDF/TXT/MD file or switch to **Paste text**, then click **Save update**. The UI
displays the source version and a SHA-256 preview; hovering the preview reveals
the full hash and document ID.

The server computes SHA-256 from the original PDF bytes or exact UTF-8 text bytes.
It does not normalize whitespace or trust a client-supplied hash of the new content.

- **Same hash:** return `changed: false`, `operation: "unchanged"`, and `No changes`.
  The source, version, status, timestamps, chunks, and vectors are retained. No
  parse job or embedding request is made. This no-op is also safe while indexing.
- **Different hash:** lock the document row, verify it is not `running`, and compare
  the `If-Match` hash against the current stored hash. Delete every old chunk/vector
  for this `doc_id`, replace the source/name, increment `source_version`, clear old
  index/error metadata, and set `pending` in the same transaction. Click **Start
  chunking** to execute the full rebuild. A rejected source update rolls back the
  entire transaction, including any vector deletion.
- **Stale hash or running document:** return 409. A page opened before another
  update cannot overwrite the new version. Identical retries remain no-ops.

Names are unique among active documents within each knowledge base. Uploading the same name and bytes
again returns the existing document with `changed: false`. Different bytes with
the same name return 409 and direct the user to **Update**, ensuring the intended
document ID is explicit. Manual **Reindex** forces a full rebuild of the current
stored content, even when its hash is unchanged.

Errors are retained on documents and jobs with sanitized provider/status messages.
Jobs also record `failed_step` and sanitized stack call frames in `error_stack`;
these diagnostic stack frames are not sent to the browser.
No API key or raw provider response is returned to the browser. Retries are manual;
there is no automatic provider retry loop beyond parse-result polling.

## Removing documents from the knowledge base

Click **Delete** on a document row to soft-delete it. The server sets `deleted_at`
without deleting source bytes, chunk rows, vector values, or job history. The
processing `status` remains separate from this removal flag. List and retrieval
queries require `deleted_at IS NULL`; all chunks of a removed document are
excluded through their `doc_id` relationship. The UI also clears its displayed
search hits for that document and filters late polling/search responses.

The delete endpoint is idempotent: repeated requests preserve the first removal
timestamp. Removed IDs return 404 for source downloads, updates, and indexing.
The name becomes available for a new upload, which gets a new ID, starts as
`pending`, and does not reuse the retained vectors. There is no restore action
in the current UI.

Documents can be removed while indexing. A queued job is consumed and marked
failed without calling providers. An active worker cannot load or commit a
removed document, and its next lease renewal fails. Provider requests already
in flight may finish, but their results cannot be stored or reactivate the
document. Removing a document after indexing finishes preserves its successful
status and vectors while excluding them from search.

## Retrieval and reranking

```text
Query -> bound Google query embedding -> pgvector candidates (default 50)
      -> Cohere rerank -> recheck current chunk eligibility -> final top K (default 5)
```

Add `COHERE_API_KEY=<your real key>` to `.env.local` using the placeholders and
optional settings in `.env.example`. Restart the development server after changing
environment configuration. The default reranker is `rerank-v4.0-fast`, using
`POST https://api.cohere.com/v2/rerank`. Both Chinese and English questions can be
sent directly to the multilingual model. This step runs during search, without
changing existing embeddings, document status, chunks, or indexing jobs.

The server sends the query plus each candidate's title and chunk text in one
request. `top_n` equals the candidate count so the complete ranking is available
for final filtering. Provider indices must be unique, in range, and cover every
candidate; scores must be finite numbers between 0 and 1. Results map back to the
original chunk IDs, document IDs, text, and page citations. Untrusted provider
text never replaces stored content.

Vector retrieval requires the configured base, model/dimensions, `success`, and
`deleted_at IS NULL`. Transaction-local HNSW iterative scanning and a larger search
candidate list help prevent those filters from exhausting the first index matches.
After the remote request, the server rechecks the exact chunk IDs against the
current database. A document deleted or replaced during reranking cannot return
stale content. Final `limit` is applied after this check, allowing lower-ranked
eligible candidates to fill the response.

Each hit keeps `score` as its original cosine similarity. A successfully reranked
hit also has `rerankScore`; results are ordered by that score, while the UI shows
both values. Neither score is an answer-confidence probability. This release
does not impose a relevance threshold; calibrate one against labeled business
queries before enabling filtering.

The query response includes `retrieval` metadata:

| Field | Meaning |
| --- | --- |
| `rerankStatus` | `applied`, `not_configured`, `unavailable`, or `empty`. |
| `rerankerModel` | Model actually used for successful reranking; otherwise `null`. |
| `candidateCount` | Actual number of vector candidates before final filtering and truncation. |
| `warning` | Visible explanation of vector-only fallback; otherwise `null`. |

An absent/placeholder key skips Cohere. A provider HTTP error, timeout, or malformed
response returns the original vector ordering with an explicit warning and no
`rerankScore`. Raw provider payloads and keys are not returned. Empty candidate
sets skip Cohere, and client cancellation aborts reranking instead of initiating
a fallback. There are no automatic Cohere retries or cached relevance scores.

## API

All responses use `private, no-store`. The routes run in the Node.js runtime.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/knowledge-base/documents` | Returns binding and active documents' IDs, status, SHA-256, source version/type, and timestamps; no source bytes. |
| `POST /api/knowledge-base/documents` | Multipart `file` (PDF/TXT/MD) or JSON `{name,text}`; 201 for new `pending`, 200 for unchanged. |
| `PUT /api/knowledge-base/documents/{id}` | Same file/text payload plus `If-Match: "<current contentHash>"`; 200 updated/unchanged, 409 conflict, 428 missing precondition. |
| `DELETE /api/knowledge-base/documents/{id}` | Soft-deletes within the configured base; 200 with `id`, `deletedAt`, and a message, including repeated deletes. Unknown/other-base IDs return 404. No provider calls. |
| `POST /api/knowledge-base/documents/{id}/index` | CAS + durable enqueue; returns 202, or 409 if running. |
| `GET /api/knowledge-base/documents/{id}/source` | Downloads original bytes with the stored MIME type. The earlier `/pdf` route remains an alias. |
| `POST /api/knowledge-base/query` | JSON `query`, optional `embeddingModel`, optional final `limit` (1–20); returns chunks with cosine similarity, optional rerank score, source pages, and `retrieval` metadata. |

Example query body:

```json
{
  "query": "What is the store's return window?",
  "embeddingModel": "gemini-embedding-2",
  "limit": 5
}
```

The query endpoint uses the stored model for query embedding and filters chunk
and document model/dimension fields. An explicitly supplied mismatched model
is rejected before making the Google call.

## Validation

```sh
npm run test:knowledge
npm run test:disputes
npm run lint
npm run build
```

Knowledge tests execute the real migration and SQL against embedded PostgreSQL
with pgvector (PGlite). They cover storage, concurrent CAS requests, transactional
rollback, successful processing, failure/retry, atomic reindexing, lease expiry,
stale-worker fencing, hash comparisons, duplicate uploads, concurrent updates,
full vector replacement, text inputs, soft-delete retention and retrieval exclusion,
idempotent deletion, same-name reuploads, removal during indexing, repeatable migrations,
immutable models, dimensions, query scoping, page citations,
candidate retrieval above the final top K, reranking, timeout/fallback, malformed
rankings, cancellation, post-rerank eligibility checks, and mocked official
provider request/response contracts. They require no database
service, external credentials, paid API calls, or access to `.env.local`.

Real provider authentication, quotas, PDF parsing quality, and deployment network
access still need verification after real credentials and PostgreSQL are configured.

## Provider references

- [LlamaParse v2 upload/parse/poll](https://developers.llamaindex.ai/llamaparse/parse/getting_started/)
- [LlamaParse response format](https://developers.llamaindex.ai/llamaparse/parse/guides/response-format/)
- [Google embedding API and task formats](https://ai.google.dev/gemini-api/docs/embeddings)
- [Cohere Rerank v2 API](https://docs.cohere.com/reference/rerank)
- [Cohere multilingual reranking](https://docs.cohere.com/docs/rerank-overview)
- [Cohere score interpretation and threshold calibration](https://docs.cohere.com/docs/reranking-best-practices)
- [pgvector operators and expression indexes](https://github.com/pgvector/pgvector)
