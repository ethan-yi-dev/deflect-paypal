# Deflect

A customer support workspace for PayPal disputes. Deflect brings the customer's
concern, case dates, refund request, and evidence requirements into one page,
then helps support staff prepare an evidence draft and review the next step.

Built with Next.js, React, and TypeScript for the
[PayPal AI Hackathon](https://paypalaihackathon.devpost.com).

> **Current scope:** dispute queries use the configured PayPal Sandbox account.
> Deflect assessment runs local evidence rules. PayPal submission is a local
> preview. LLM recommendations, Policy/JEV validation, and real dispute actions
> are planned integrations.

## Current features

| Feature | Current behavior |
| --- | --- |
| Dispute list | Queries the merchant's disputes and lists the returned cases in **Active cases**. |
| Case selection | Opens the latest updated case by default; supports clicking another case, loading a known ID, and refreshing the list. |
| Support details | Shows the initiator, conversation, dates, response deadline, amounts, related items, and requested evidence. |
| Evidence preparation | Displays fields according to the dispute reason and the evidence requested from the seller. |
| File selection | Validates local files, lists names and sizes, supports removal, and keeps drafts separate by case. |
| Deflect assessment | Checks draft completeness and returns a rule-based suggestion about missing evidence or review steps. |
| PayPal submission | Opens a review preview when the case offers evidence submission; sends no evidence or action requests. |
| Demo studio | Offers three fixed scenarios with predefined recommendations, Policy/JEV results, and a simulated audit trail. |
| RAG knowledge base | Stores and versions PDF/text sources, indexes them asynchronously, and retrieves evidence with pgvector and Cohere reranking. Includes SHA-256 change detection, soft deletion, and worker recovery. See [RAG pipeline](#rag-pipeline-and-knowledge-base). |

The support details use neutral cards. **Evidence & next steps** is a separate
**ACTION WORKSPACE**, with a dark green header, highlighted border, and its own
operation bar. The layout adapts to smaller screens, where cases appear above
the details.

## Run locally

### Requirements

- Node.js **20.9 or later** and npm.
- A [PayPal Sandbox REST app](https://developer.paypal.com/dashboard/applications/sandbox)
  with credentials for the merchant whose disputes you want to view.
- Server access to `https://api-m.sandbox.paypal.com`.

### Install and configure

```bash
npm install
```

Create `.env.local` from [.env.example](.env.example) if it does not already exist.
Keep your existing `.env.local` when it is already configured.

PowerShell:

```powershell
if (!(Test-Path .env.local)) { Copy-Item .env.example .env.local }
```

Bash:

```bash
test -f .env.local || cp .env.example .env.local
```

Fill in your Sandbox credentials:

```dotenv
PAYPAL_CLIENT_ID=your_sandbox_client_id
PAYPAL_SECRET=your_sandbox_secret
```

These values are read on the server. Keep them without a `NEXT_PUBLIC_` prefix.
The `.env.local` file is ignored by Git. Restart the dev server after changing
credentials.

### Start the application

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

One command starts the Next.js frontend and backend. The browser queries
same-origin `/api/disputes` routes, and the server calls PayPal. This setup does
not require a separate frontend server or browser CORS configuration for PayPal.

Without credentials, live queries show a configuration error. You can still
choose **View demo studio** to explore the fixed demo scenarios.

## Using the workspace

### 1. Select a dispute

The home page first loads the account's dispute list, then opens the most
recently updated case in that response. **Active cases** shows each returned
case's reference, amount, reason, and status. Click a case to load its details,
or use **Case reference** to query a known dispute ID directly.

The refresh button beside **Active cases** reloads the list and keeps the
selected case if it is still present. The current list query returns PayPal's
first page only; automatic pagination and an account-wide search are not
implemented.

### 2. Read the customer context

- **Dispute summary:** reason, status, amount, initiator, opening time, and seller response deadline.
- **Customer's concern:** buyer/seller messages with author and time, requested refund amount, and related items.
- **Response details:** case status guidance, requested evidence, PayPal's refund limit, and payment holds when present.
- **Case activity:** opening time, last update, and seller response deadline in Pacific time (`America/Los_Angeles`).

The initiator comes from case creation evidence. If that evidence is missing,
it stays unknown. Missing information is not filled with demo data. Tracking
supplied in the case is not treated as confirmed delivery; carrier lookups are
not connected.

Internal transaction and merchant IDs, fund movement history, API action names,
and raw JSON are kept out of the support view. A case reference remains visible
so support staff can identify the dispute.

### 3. Prepare evidence and review the next step

In **Evidence & next steps**:

1. Review the evidence labeled **Requested by PayPal**. Fill the relevant carrier,
   tracking, refund reference, or note fields.
2. When **Submission available** is shown, choose files in **Add evidence files**.
   The list shows each file's name, size, and **Not uploaded** status. Remove any
   file you do not want to include.
3. Click **Run Deflect assessment** to check the draft and see what to collect or
   review next. Editing the draft clears the previous result. Switching or
   refreshing cases also requires running the assessment again.
4. Click **Submit evidence to PayPal** to review the local submission preview.
   **Confirm preview** is enabled only when a seller request is present and the
   required draft fields pass the basic check. Confirmation displays a local
   notice; it does not contact PayPal.

Files already returned by PayPal as seller-submitted documents appear separately
under **Files already on PayPal**. Selecting a local file does not add it to that
list.

Notes and files stay in memory with each case while switching cases inside the
live workspace. Reloading the page or switching to the demo studio clears those
evidence drafts. Knowledge-base documents are stored separately in PostgreSQL and persist across reloads.

### 4. Customize your knowledge base

Open **Customize Your own knowledge base** to upload documents, paste text, manage
existing sources, and search indexed content. The same knowledge base is available
from the live workspace and demo studio. Follow the dedicated [RAG setup and
pipeline guide below](#rag-pipeline-and-knowledge-base) before indexing.

## RAG pipeline and knowledge base

Deflect implements the document ingestion, indexing, retrieval, and reranking
stages of RAG. The current search returns evidence chunks with document names,
page citations, and relevance scores. Generating an LLM answer from that evidence
and using it in dispute assessments are planned integrations.
The current application uses one configured knowledge base and has no per-user
knowledge-base access controls.

### Architecture

```mermaid
flowchart TD
    upload["Upload PDF / TXT / Markdown / text"] --> pending["Store original and SHA-256: pending"]
    pending -->|"Start chunking: atomic CAS"| worker["PostgreSQL queue and indexing worker"]
    worker --> parse["PDF: LlamaParse; text: direct input"]
    parse --> chunk["LlamaIndex chunking: 512 tokens, overlap 64"]
    chunk --> embed["Google document embedding"]
    embed --> store[("PostgreSQL + pgvector: success")]
    query["User query"] --> queryEmbed["Google query embedding: same bound model"]
    queryEmbed --> candidates["Vector retrieval: up to 50 candidates by default"]
    store --> candidates
    candidates --> rerank["Cohere reranking"]
    rerank --> eligible["Recheck document and chunk eligibility"]
    eligible --> results["Return final top K with citations: default 5"]
```

PDFs are parsed into Markdown pages by LlamaParse. LlamaIndex's local
`SentenceSplitter` creates chunks while preserving page references. TXT, Markdown,
and pasted text skip PDF parsing and use page number 1. Google AI Studio provides
the embeddings; the default binding is `gemini-embedding-2` with 768 dimensions.

All knowledge-base data lives in PostgreSQL; pgvector is an extension of that same
database. The bundled [compose.yaml](compose.yaml) runs PostgreSQL 17 with pgvector.

| Table | Responsibility |
| --- | --- |
| `t_knowledge_base` | Knowledge-base ID and immutable embedding model/dimension binding. |
| `t_knowledge_document` | PDF bytes in `pdf_data` or UTF-8 `text_content`, SHA-256, source version, processing status, timestamps, and soft-delete flag. |
| `t_knowledge_chunk` | Chunk text, page, sequence, model binding, and vector; linked to its document by `doc_id`. |
| `t_knowledge_job` | Durable indexing attempts, source hash snapshots, leases, and execution/error records. |

### Configuration and startup

Use the Node.js and dependency setup in [Run locally](#run-locally). The knowledge
base additionally needs PostgreSQL with **pgvector 0.8.0 or newer**, a Google AI
Studio key, and a LlamaParse key. A Cohere key enables reranking.

Merge these fields from [.env.example](.env.example) into `.env.local`, preserving
existing PayPal credentials. Replace API key placeholders with real keys.

```dotenv
DATABASE_URL=postgresql://deflect:anyword@localhost:5432/deflect
KNOWLEDGE_BASE_ID=default

GEMINI_API_KEY=anyword
GEMINI_EMBEDDING_MODEL=gemini-embedding-2
GEMINI_EMBEDDING_DIMENSIONS=768

LLAMA_CLOUD_API_KEY=anyword
LLAMA_PARSE_TIER=agentic

COHERE_API_KEY=anyword
COHERE_RERANK_MODEL=rerank-v4.0-fast
KNOWLEDGE_RERANK_CANDIDATES=50
KNOWLEDGE_RERANK_TIMEOUT_MS=10000
```

The database URL matches the bundled local Docker configuration. Start it:

```bash
docker compose up -d postgres
```

Once PostgreSQL is healthy, apply the numbered migrations:

```bash
npm run db:migrate
```

Start the application in one terminal:

```bash
npm run dev
```

Start the indexing worker in another terminal:

```bash
npm run worker:knowledge
```

If the app is already running, start only the worker. Restart the app and worker
after changing their environment configuration. Production runs the built Next.js
app and worker as separate supervised processes.

The first use binds the embedding model and dimensions to the knowledge base.
Indexing and query both verify that binding, and a database trigger prevents
changing it. To switch embedding models or dimensions, create a new
`KNOWLEDGE_BASE_ID` and index the sources there. Changing the reranker does not
require rebuilding embeddings.

### Indexing and document lifecycle

Upload nonempty PDF, UTF-8 TXT, or Markdown files up to **50 MiB each**, or use
**Paste text**. Saving a source stores it as `pending`; indexing starts only when
the user clicks **Start chunking**.

```text
Upload -> pending
Start chunking -> running (queued, then consumed by a worker)
Parse -> Chunk -> Embed -> Store -> success
Processing error or expired worker lease -> failed -> manual retry
```

| Action | Behavior |
| --- | --- |
| **Start chunking** | Atomically sets `running` only if the document is not already running, then inserts a durable job in the same transaction. |
| **Update**, unchanged SHA-256 | Returns **No changes**; preserves the source, version, timestamps, chunks, and vectors. No indexing job is created. |
| **Update**, changed SHA-256 | Checks the current hash with `If-Match`, keeps the document ID, increments the version, deletes old vectors, and returns to `pending` in one transaction. Click **Start chunking** to rebuild. |
| **Reindex** | Forces a full rebuild of the stored source, including removal of old vectors, even when its hash is unchanged. |
| **Retry chunking** | Manually starts another attempt after a failed job. |
| **Delete** | Sets `deleted_at`; retains the original, chunks, vectors, and job history while excluding them from the list and search. Repeated deletion is idempotent. |

Active names are unique within each base. Uploading the same name and bytes is a
no-op; different bytes under an existing name require **Update** by document ID.
After soft deletion, the same name can be uploaded as a new document with a new ID.
There is no restore action in the current UI.

Each job has a two-minute lease renewed every 30 seconds. The active run ID,
source hash, and live lease prevent stale workers from publishing results. New
chunks and `success` commit together; a processing failure leaves no old or
partially written index. Deleted documents cannot be reactivated by an in-flight
worker. Changed updates are rejected while indexing is running.

While the knowledge-base view is open, the UI polls after each response: every
2 seconds when a document is running, otherwise every 10 seconds. Navigation away
stops polling. Browser tab visibility does not currently pause it.

### Retrieval, reranking, and fallback

**Search your knowledge** embeds the query with the bound Google model and
retrieves up to 50 vector candidates by default. Only `success` documents with
`deleted_at IS NULL` and matching base/model/dimensions are eligible. The default
768-dimensional vectors use an HNSW cosine index, with transaction-local iterative
scanning to help fill the candidate set after filtering.

The configured default, Cohere `rerank-v4.0-fast`, scores the query against candidate titles and
chunk text. The server maps the ranking back to the original chunks, rechecks
their current database eligibility, and then selects the final top K. Documents
deleted or replaced during reranking are filtered out before returning results.

| Setting or result | Meaning |
| --- | --- |
| `KNOWLEDGE_RERANK_CANDIDATES` | Internal candidate count; default 50, configurable from 20 to 100. |
| Query `limit` | Final result count; default 5, configurable from 1 to 20. |
| `score` / **Similarity** | Original cosine similarity, retained even after reranking. |
| `rerankScore` / **Rerank** | Cohere relevance score, present only after successful reranking. |
| `retrieval` | Response metadata with rerank status, model used, candidate count, and any fallback warning. |

Missing/placeholder Cohere keys skip reranking. A provider error, invalid ranking,
or timeout (default 10 seconds) falls back to vector ordering with an explicit
warning. Empty candidate sets skip Cohere. Neither score represents answer
confidence, and no minimum relevance threshold or keyword hybrid search is
currently applied.

### API and validation

| Endpoint | Purpose |
| --- | --- |
| `GET /api/knowledge-base/documents` | List active documents and the model binding. |
| `POST /api/knowledge-base/documents` | Upload a multipart file or JSON `{name,text}`. |
| `PUT /api/knowledge-base/documents/{id}` | Update a source using its current `If-Match` hash. |
| `DELETE /api/knowledge-base/documents/{id}` | Soft-delete a document. |
| `POST /api/knowledge-base/documents/{id}/index` | Trigger asynchronous indexing. |
| `GET /api/knowledge-base/documents/{id}/source` | Download the stored original. |
| `POST /api/knowledge-base/query` | Retrieve and rerank evidence chunks. |

`npm run test:knowledge` runs PostgreSQL/pgvector tests with PGlite and mocked
provider contracts. Coverage includes concurrency, rollback, worker recovery,
hash updates, soft deletion, reranking, fallback, and eligibility checks after
concurrent document changes. These tests require no external database, API keys,
or paid provider calls; retrieval quality still needs evaluation on real business
questions.

The [knowledge-base engineering guide](documents/knowledge-base.md) contains full
configuration details, transaction guarantees, API behavior, and provider references.

## Evidence rules

The baseline follows PayPal's
[dispute reasons and evidence guide](https://developer.paypal.com/platforms/disputes/reference/dispute-reasons/).
It covers item not received, item not as described, unauthorized purchase,
credit not processed, duplicate transaction, incorrect amount, payment by other
means, canceled recurring billing, and other disputes.

The actual case's evidence request takes precedence:

- `reason` selects the baseline guidance.
- Only `evidences[]` entries with `source: REQUESTED_FROM_SELLER` become seller requirements.
- Their `evidence_type` values determine which fields are shown.
- A POST link with `rel: provide_evidence` or `provide-evidence` and a nonempty `href` enables file selection and the submission preview.

If no specific seller request is returned, the page labels the baseline entries
**Reference option**. These are possible alternatives, not a requirement to
submit every type. Unknown reasons or evidence types require manual review.

| Evidence | Basic draft check |
| --- | --- |
| Fulfillment proof for item not received | Carrier and tracking, **or** an explanatory note or selected delivery document. |
| Fulfillment proof for unauthorized purchase | Carrier and tracking; a file alone is insufficient. |
| Refund proof | A reference for an already issued PayPal refund; a receipt alone is insufficient. |
| Other supporting evidence | An explanatory note or selected document. |

Notes are limited to 2,000 characters. The checker verifies the presence of draft
fields; it does not authenticate documents, confirm delivery or refunds, or
approve a financial action. A selected file can satisfy a draft check while its
actual contents still need review.

Providing evidence through `provide-evidence` and making a formal `appeal` are
separate PayPal actions. The current preview prepares evidence submission;
formal appeals are not implemented. See
[PayPal's Disputes API guide](https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api/).

### File limits

Following PayPal's
[supported file types and sizes](https://developer.paypal.com/platforms/disputes/reference/supported-file-types-sizes/):

- JPG, JPEG, GIF, PNG, and PDF.
- Nonempty files, each **smaller than 10 MB**.
- Up to **50 MB total** across the selected files for a case.

The local validator checks the extension, the MIME type when the browser supplies
one, and file sizes. These checks do not validate the file contents.

## Demo studio

**View demo studio** switches to independent fixtures in
[app/demo-dispute.ts](app/demo-dispute.ts). It works without PayPal credentials.

| Scenario | Demonstrates |
| --- | --- |
| Missing tracking | An evidence gap and a predefined response. |
| Delivery confirmed | A predefined response using explicitly fictional shipment data. |
| Injection attempt | An unsafe proposal rejected by predefined Policy/JEV checks. |

**Run demo analysis** replays the chosen scenario's fixed recommendation.
**Preview action → Simulate action** adds a local audit entry. No LLM, message,
evidence submission, or refund is executed. This demo is not an evaluation of a
real case or a working Policy/JEV implementation.

**View PayPal disputes** returns to live Sandbox queries. Failed live queries
never fall back to the demo fixtures. Demo state resets when leaving the studio.

## Backend and project structure

```text
Browser → Next.js /api/disputes → PayPal Sandbox Disputes REST API
        → Local evidence rules and submission preview
```

| Endpoint | Response |
| --- | --- |
| `GET /api/disputes` | `items`, `fetchedAt`, and `environment: sandbox`; first list page only. |
| `GET /api/disputes/{id}` | Normalized `dispute` details, `fetchedAt`, and `environment: sandbox`. |

The Disputes client obtains and caches an OAuth token, shares concurrent token
requests, and retries a GET once after a rejected token. IDs are validated before
querying PayPal. Dispute responses use `private, no-store`, and provider errors
are sanitized. Credentials and tokens are not returned to the browser. The
Disputes client uses a fixed Sandbox host and never follows action links or
performs dispute mutations.

The API detail response retains operational fields for future backend work;
the frontend chooses the customer support fields to display. Knowledge-base upload,
update, soft deletion, indexing, and reranked search endpoints are implemented
separately. PayPal evidence submission, execution, and appeal endpoints remain
planned integrations.

| File | Responsibility |
| --- | --- |
| [app/live-dispute-workspace.tsx](app/live-dispute-workspace.tsx) | Live case list, customer context, selection, and case drafts. |
| [app/dispute-evidence.tsx](app/dispute-evidence.tsx) | Evidence fields, local file lists, assessment results, and submission preview. |
| [lib/dispute-evidence.ts](lib/dispute-evidence.ts) | Baseline evidence rules, draft checks, and file validation. |
| [lib/disputes.ts](lib/disputes.ts) | Shared types and normalization of PayPal responses. |
| [lib/paypal-disputes.ts](lib/paypal-disputes.ts) | Server-only facade and sanitized API error responses. |
| [lib/paypal-disputes-client.ts](lib/paypal-disputes-client.ts) | OAuth and read-only Disputes REST requests. |
| [app/dispute-workspace.tsx](app/dispute-workspace.tsx) | Mode switching and the static demo studio. |
| [app/knowledge-base.tsx](app/knowledge-base.tsx) | Document management, indexing controls, status polling, and search results. |
| [lib/knowledge/](lib/knowledge/) | Configuration, PostgreSQL repository, document validation, providers, worker processing, retrieval, and reranking. |
| [scripts/knowledge-worker.ts](scripts/knowledge-worker.ts) | Standalone durable indexing worker. |
| [db/migrations/](db/migrations/) | Repeatable PostgreSQL and pgvector schema migrations. |
| [tests/paypal-disputes.test.ts](tests/paypal-disputes.test.ts) | Mocked API client, normalization, evidence, and file checks. |
| [tests/knowledge-base.test.ts](tests/knowledge-base.test.ts) | PostgreSQL/pgvector storage, document lifecycle, CAS, worker recovery, and retrieval eligibility tests. |
| [tests/knowledge-rerank.test.ts](tests/knowledge-rerank.test.ts) | Rerank API contract, result mapping, fallback, timeout, and cancellation checks. |

The original SDK pages remain available:

| Route | Data source | Shows |
| --- | --- | --- |
| `/transactions` | `getRecentTransactions()` | First 20 transactions from the last 30 days. |
| `/subscriptions` | `getBillingPlans()` | First 20 subscription billing plans. |
| `/balances` | `getBalances()` | Current balance per currency. |

These pages use [lib/paypal.ts](lib/paypal.ts) and the
[PayPal TypeScript Server SDK](https://github.com/paypal/PayPal-TypeScript-Server-SDK).
The transaction page additionally requires the app's **Transaction search**
feature. Disputes use a separate REST client because the installed SDK does not
expose a Disputes controller.

## Development checks

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the UI and API routes in development. |
| `npm run lint` | Run ESLint. |
| `npm run test:disputes` | Compile and run the mocked Disputes and evidence checks with Node's test runner. |
| `npm run test:knowledge` | Test PostgreSQL/pgvector storage, document lifecycle, worker recovery, and retrieval/reranking with mocked providers. |
| `npm run db:migrate` | Initialize the PostgreSQL knowledge-base schema and pgvector extension. |
| `npm run worker:knowledge` | Run the durable indexing queue worker alongside the Next.js server. |
| `npm run build` | Build the production application and check TypeScript. |
| `npm run start` | Serve an existing production build. |

The dispute tests use mocked PayPal responses and do not need credentials or
send live PayPal requests. They cover token sharing/refresh, query errors, ID
validation, missing facts, seller evidence selection, baseline alternatives,
unknown evidence, and file limits.

Run the test and build commands sequentially: dispute test compilation and the
Next.js build both write generated files under `.next`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| PayPal is not configured | Fill both values in `.env.local` and restart the dev server. |
| Authentication or access error | Check the Sandbox credentials and the app/merchant's Disputes access. |
| No cases listed | Confirm the configured merchant account; load a known dispute ID directly if needed. Only the first list page is queried. |
| File selection or submission is unavailable | The current detail response has no applicable POST evidence link. |
| Assessment requests more evidence | Follow the missing-field suggestions; refund and tracking evidence need their structured references where required. |
| Preview confirmation is disabled | A specific seller request and complete draft fields are required. |
| Files disappeared | Drafts are in-memory and reset on reload or when leaving the live workspace. |
| Timeout or rate limit | Check server connectivity to PayPal; wait before retrying a rate-limited request. |
| Knowledge database is unavailable | Start PostgreSQL, check `DATABASE_URL`, and apply `npm run db:migrate` with pgvector available. |
| A knowledge document stays `running` | Start `npm run worker:knowledge` to consume queued jobs and recover expired leases. Failed attempts can be retried manually. |
| Search shows a vector-only warning | Configure `COHERE_API_KEY` and restart the app, or check the reported Cohere credentials, quota, model, and timeout error. |
| A knowledge document has no search hits | Confirm indexing reached `success`, the document is not soft-deleted, and the configured embedding binding matches. |

## Planned integrations

The intended flow is:

```text
Read dispute → Query order and carrier facts → LLM recommendation
             → Policy / JEV validation → Execute action → Persist audit log
```

The current implementation covers dispute reads, evidence preparation, and local
rule checks. Remaining work includes order/carrier queries, LLM integration,
Policy/JEV validation, actual PayPal evidence submission or other actions,
persistent drafts and audit logs, pagination, and application authentication.

## Origin and attribution

Deflect is based on the official PayPal starter repository,
[`paypaldev/hackathon-paypal-ag-grid-boilerplate`](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate),
at commit [`8de661bda9f6dd10c5d930767e8cb185a15f6b83`](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate/tree/8de661bda9f6dd10c5d930767e8cb185a15f6b83).
The initial Deflect codebase matches that baseline. The following material
was inherited from the starter:

- **PayPal integration:** `lib/paypal.ts`, including the sandbox SDK client and transaction, subscription-plan, and balance queries; `env.example`.
- **Pages and UI:** `app/page.tsx`, the pages under `app/transactions/`, `app/subscriptions/`, and `app/balances/`, plus `app/data-table.tsx`, `app/layout.tsx`, `app/globals.css`, and `app/favicon.ico`.
- **Project scaffolding and assets:** `package.json`, the initial `package-lock.json`, `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, `.gitignore`, the assets under `public/`, and `AGENTS.md` / `CLAUDE.md`.
- **Documentation:** the hackathon introduction, local setup instructions, SDK explanations, data-page descriptions, and sandbox response examples in this README.

Subsequent original additions and modifications are contributions to Deflect;
the inherited portions retain the attribution above.

## License

Original contributions to Deflect are licensed under the MIT License; see
[`LICENSE`](LICENSE). The recorded upstream starter has no `LICENSE` file,
so this project's MIT license does **not** cover the inherited material or
grant permission on behalf of its rights holders. Third-party dependencies
and assets remain subject to their respective licenses.

## Starter SDK response examples

<details>
<summary>Expand the original Sandbox response examples</summary>

The examples below are real sandbox responses as the SDK returns them (camelCase fields, not the REST API's snake_case).

### `/transactions`

`searchTransactions({ startDate, endDate, fields: 'all', pageSize: 20 })` returns `transactionDetails[]`. Transaction Search accepts at most a 31-day range, and new activity can take up to three hours to appear. `fields: 'all'` adds `payerInfo` and the other sections; without it only `transactionInfo` is returned.

One `transactionDetails` item (a payout):

```json
{
  "transactionInfo": {
    "transactionId": "10890159B0554833L",
    "paypalReferenceId": "1FX78001X2681601H",
    "paypalReferenceIdType": "TXN",
    "transactionEventCode": "T0001",
    "transactionInitiationDate": "2026-09-23T12:11:56Z",
    "transactionUpdatedDate": "2026-09-23T12:11:56Z",
    "transactionAmount": { "currencyCode": "USD", "value": "-1.00" },
    "feeAmount": { "currencyCode": "USD", "value": "-0.25" },
    "transactionStatus": "P",
    "transactionSubject": "Probe payout",
    "transactionNote": "probe",
    "endingBalance": { "currencyCode": "USD", "value": "4997.50" },
    "availableBalance": { "currencyCode": "USD", "value": "4997.50" },
    "customField": "probe-1",
    "protectionEligibility": "02",
    "instrumentType": "PayPal",
    "instrumentSubType": "PayPal Wallet"
  },
  "payerInfo": {
    "emailAddress": "probe-receiver@example.com",
    "phoneNumber": { "countryCode": "1", "nationalNumber": "2028188144" },
    "addressStatus": "N",
    "payerName": {}
  },
  "shippingInfo": { "name": "John, Doe" },
  "cartInfo": {},
  "storeInfo": {},
  "auctionInfo": {},
  "incentiveInfo": {}
}
```

`transactionEventCode` is a [PayPal T-code](https://developer.paypal.com/docs/transaction-search/transaction-event-codes/) (`T0001` = payout). `transactionStatus` is `S` success, `P` pending, `D` denied, `V` reversed or `F` partially refunded.

### `/subscriptions`

`listBillingPlans({ pageSize: 20, prefer: 'return=representation' })` returns `plans[]`. The `prefer` header makes the list include `billingCycles` and `paymentPreferences`, which the default list response omits.

One `plans` item (a plan with a 30-day trial):

```json
{
  "id": "P-3RM52651TF551181NNKZ4BHQ",
  "productId": "AGGRID-CLOUD-STORAGE",
  "name": "Cloud Storage Basic (100 GB)",
  "status": "ACTIVE",
  "description": "Cloud Storage: Cloud Storage Basic (100 GB)",
  "billingCycles": [
    {
      "frequency": { "intervalUnit": "DAY", "intervalCount": 30 },
      "tenureType": "TRIAL",
      "sequence": 1,
      "totalCycles": 1
    },
    {
      "pricingScheme": {
        "version": 1,
        "fixedPrice": { "currencyCode": "USD", "value": "2.99" },
        "createTime": "2026-09-23T12:05:50Z",
        "updateTime": "2026-09-23T12:05:50Z"
      },
      "frequency": { "intervalUnit": "MONTH", "intervalCount": 1 },
      "tenureType": "REGULAR",
      "sequence": 2,
      "totalCycles": 0
    }
  ],
  "paymentPreferences": {
    "autoBillOutstanding": true,
    "setupFee": { "currencyCode": "USD", "value": "0.0" },
    "setupFeeFailureAction": "CONTINUE",
    "paymentFailureThreshold": 3
  },
  "quantitySupported": false,
  "createTime": "2026-09-23T12:05:50Z",
  "updateTime": "2026-09-23T12:05:50Z",
  "links": [
    {
      "href": "https://api.sandbox.paypal.com/v1/billing/plans/P-3RM52651TF551181NNKZ4BHQ",
      "rel": "self",
      "method": "GET"
    }
  ]
}
```

`totalCycles: 0` on the `REGULAR` cycle means the plan bills until cancelled.

### `/balances`

`searchBalances({})` returns the current balances. Pass `asOfTime` to get the balance at an earlier point in time.

```json
{
  "balances": [
    {
      "currency": "USD",
      "totalBalance": { "currencyCode": "USD", "value": "3537.71" },
      "availableBalance": { "currencyCode": "USD", "value": "3537.71" },
      "withheldBalance": { "currencyCode": "USD", "value": "0.00" }
    }
  ],
  "accountId": "QXJYHKET9Y4VC",
  "asOfTime": "2026-09-28T10:59:59Z",
  "lastRefreshTime": "2026-09-28T10:59:59Z"
}
```

</details>
