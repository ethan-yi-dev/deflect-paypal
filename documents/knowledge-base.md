# Knowledge base

The knowledge base is shared by the live and demo workspaces. PDFs, metadata,
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

Open **Customize Your own knowledge base**. Upload a PDF, then click **Start
chunking**. The worker calls LlamaParse and Google; uploading alone stores the
PDF and does not invoke paid providers. Click a document name to download its
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

Schema: [`db/migrations/001_knowledge_base.sql`](../db/migrations/001_knowledge_base.sql).

| Table | Stores |
| --- | --- |
| `t_knowledge_base` | Knowledge-base identity and immutable embedding model/dimension binding. |
| `t_knowledge_document` | Original PDF in `pdf_data bytea`, filename, size, status, model binding, active run ID, error, timestamps, and chunk count. |
| `t_knowledge_chunk` | Chunk text, page, sequence, pgvector embedding, model binding; `doc_id` references the document. |
| `t_knowledge_job` | Durable queued/working/done/failed indexing attempts and worker leases. |

The PDF limit is 50 MiB per file. The API enforces both streamed request size and
the PDF's size/signature; the database checks byte length and the size limit.
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
User retries/reindexes -> running
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
returns 409. The update and job insert commit in the same transaction; a queue
write failure rolls back the status change. Uploads do not automatically queue jobs.

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
the parse polling deadline is 15 minutes.

All new chunks are prepared before a transaction replaces the previous chunks
and marks the document `success`. A failed attempt does not expose partial
vectors. The document's active run ID and the job's live lease fence the final
write, so a stale worker cannot overwrite a retried job. Failed and running
documents are excluded from retrieval even if they have earlier chunks.

Errors are retained on documents and jobs with sanitized provider/status messages.
Jobs also record `failed_step` and sanitized stack call frames in `error_stack`;
these diagnostic stack frames are not sent to the browser.
No API key or raw provider response is returned to the browser. Retries are manual;
there is no automatic provider retry loop beyond parse-result polling.

## API

All responses use `private, no-store`. The routes run in the Node.js runtime.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/knowledge-base/documents` | Returns the model binding and document metadata, never the PDF bytes. |
| `POST /api/knowledge-base/documents` | Multipart `file`: one PDF; returns 201 with `pending`. |
| `POST /api/knowledge-base/documents/{id}/index` | CAS + durable enqueue; returns 202, or 409 if running. |
| `GET /api/knowledge-base/documents/{id}/pdf` | Downloads the PDF stored in PostgreSQL. |
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
stale-worker fencing, immutable models, dimensions, query scoping, page citations,
and mocked official provider request/response contracts. They require no database
service, external credentials, paid API calls, or access to `.env.local`.

Real provider authentication, quotas, PDF parsing quality, and deployment network
access still need verification after real credentials and PostgreSQL are configured.

## Provider references

- [LlamaParse v2 upload/parse/poll](https://developers.llamaindex.ai/llamaparse/parse/getting_started/)
- [LlamaParse response format](https://developers.llamaindex.ai/llamaparse/parse/guides/response-format/)
- [Google embedding API and task formats](https://ai.google.dev/gemini-api/docs/embeddings)
- [pgvector operators and expression indexes](https://github.com/pgvector/pgvector)
