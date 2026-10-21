# Knowledge base

The knowledge base is shared by the live and demo workspaces. PDF/text sources, metadata,
chunks, vectors, and jobs all persist in PostgreSQL. No object store, separate
vector database, Redis service, or browser storage is required.

## Setup

1. Install dependencies with `npm install`.
2. Add the values in [`.env.example`](../.env.example) to your existing `.env.local`.
   Keep the existing PayPal credentials. Replace `anyword` API keys with real keys.
3. Start a PostgreSQL server with pgvector installed. If Docker is available, the
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

Schema: [`001_knowledge_base.sql`](../db/migrations/001_knowledge_base.sql) and
[`002_document_hash_updates.sql`](../db/migrations/002_document_hash_updates.sql).
`npm run db:migrate` applies all numbered migrations in order. They are repeatable;
the hash migration backfills existing PDFs without deleting their contents. Existing
duplicate names within one base must be resolved before adding the unique name index.

| Table | Stores |
| --- | --- |
| `t_knowledge_base` | Knowledge-base identity and immutable embedding model/dimension binding. |
| `t_knowledge_document` | Original PDF in `pdf_data bytea` or UTF-8 text in `text_content`; content type, SHA-256 `content_hash`, `source_version`, status, binding, timestamps, and chunk count. |
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

The actual statement also scopes the base and checks the model binding. Exactly
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
failed, and running documents are excluded from retrieval.

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

Names are unique within each knowledge base. Uploading the same name and bytes
again returns the existing document with `changed: false`. Different bytes with
the same name return 409 and direct the user to **Update**, ensuring the intended
document ID is explicit. Manual **Reindex** forces a full rebuild of the current
stored content, even when its hash is unchanged.

Errors are retained on documents and jobs with sanitized provider/status messages.
Jobs also record `failed_step` and sanitized stack call frames in `error_stack`;
these diagnostic stack frames are not sent to the browser.
No API key or raw provider response is returned to the browser. Retries are manual;
there is no automatic provider retry loop beyond parse-result polling.

## API

All responses use `private, no-store`. The routes run in the Node.js runtime.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/knowledge-base/documents` | Returns binding, document IDs, status, SHA-256, source version/type, and timestamps; no source bytes. |
| `POST /api/knowledge-base/documents` | Multipart `file` (PDF/TXT/MD) or JSON `{name,text}`; 201 for new `pending`, 200 for unchanged. |
| `PUT /api/knowledge-base/documents/{id}` | Same file/text payload plus `If-Match: "<current contentHash>"`; 200 updated/unchanged, 409 conflict, 428 missing precondition. |
| `POST /api/knowledge-base/documents/{id}/index` | CAS + durable enqueue; returns 202, or 409 if running. |
| `GET /api/knowledge-base/documents/{id}/source` | Downloads original bytes with the stored MIME type. The earlier `/pdf` route remains an alias. |
| `POST /api/knowledge-base/query` | JSON `query`, optional `embeddingModel`, optional `limit` (1–20); returns chunks with cosine similarity and source pages. |

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
full vector replacement, text inputs, immutable models, dimensions, query scoping, page citations,
and mocked official provider request/response contracts. They require no database
service, external credentials, paid API calls, or access to `.env.local`.

Real provider authentication, quotas, PDF parsing quality, and deployment network
access still need verification after real credentials and PostgreSQL are configured.

## Provider references

- [LlamaParse v2 upload/parse/poll](https://developers.llamaindex.ai/llamaparse/parse/getting_started/)
- [LlamaParse response format](https://developers.llamaindex.ai/llamaparse/parse/guides/response-format/)
- [Google embedding API and task formats](https://ai.google.dev/gemini-api/docs/embeddings)
- [pgvector operators and expression indexes](https://github.com/pgvector/pgvector)
