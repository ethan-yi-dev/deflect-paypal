# Deflect

A customer support workspace for PayPal disputes. Deflect brings the customer's
concern, case dates, refund request, and evidence requirements into one page,
then helps support staff prepare an evidence draft and review the next step.

Built with Next.js, React, and TypeScript for the
[PayPal AI Hackathon](https://paypalaihackathon.devpost.com).

> **Current scope:** dispute queries use the configured PayPal Sandbox account.
> Deflect assessment combines case data, uploaded evidence and policy retrieval
> through OpenAI. Merchants can review and confirm evidence submissions to PayPal
> Sandbox. Policy/JEV validation, refunds and other dispute actions are planned integrations.

## Current features

| Feature | Current behavior |
| --- | --- |
| Dispute list | Queries the merchant's disputes and lists the returned cases in **Active cases**. |
| Case selection | Opens the latest updated case by default; supports clicking another case, loading a known ID, and refreshing the list. |
| Support details | Shows the initiator, conversation, dates, response deadline, amounts, related items, and requested evidence. |
| Evidence preparation | Displays fields according to the dispute reason and the evidence requested from the seller. |
| File selection | Validates PDF/image evidence, supports removal, and keeps drafts separate by case even when PayPal submission is unavailable. |
| Deflect assessment | Combines a fresh case snapshot, actual attachments and top K policy passages into a cited assessment, recommendation, evidence checklist and response draft. Marks earlier results for reassessment after edits. |
| PayPal submission | Validates the current seller request, previews the exact evidence, and sends it to PayPal Sandbox after merchant confirmation. Persists receipts and prevents duplicate submissions. |
| Demo studio | Offers three fixed scenarios with predefined recommendations, Policy/JEV results, and a simulated audit trail. |
| RAG knowledge base | Stores and versions PDF/text sources, processes one selected document per request, and retrieves evidence with pgvector and Cohere reranking. Includes SHA-256 change detection, soft deletion, persisted progress, and interrupted-request recovery. See [RAG pipeline](#rag-pipeline-and-knowledge-base). |

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
OPENAI_API_KEY=your_openai_api_key
OPENAI_ASSESSMENT_MODEL=gpt-5.4-mini
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
2. Choose files in **Add evidence files**, including when submission is unavailable.
   The list shows each file's name, size, and **Local draft** status. Remove any
   file you do not want to include.
3. Click **Run Deflect assessment** to send the notes and actual files to OpenAI,
   together with a fresh PayPal case and up to 6 relevant policy passages by default.
   Review the cited assessment, recommendation, evidence gaps and response draft.
   Edits mark the previous result for reassessment. See the
   [workspace assessment guide](documents/workspace-assessment.md) for configuration,
   source handling, limits and the API contract.
4. Click **Submit evidence to PayPal** to prepare a server-validated preview of the
   notes, references and files. **Confirm & submit to Sandbox** sends exactly that
   reviewed package to PayPal. The server checks the case again before sending;
   success records a receipt and refreshes the case. See
   [PayPal evidence submission](#paypal-evidence-submission) for setup and request details.

Files already returned by PayPal as seller-submitted documents appear separately
under **Files already on PayPal**. Selecting a local file does not add it to that
list.

Notes, files and the latest assessment stay in memory with each case while switching cases inside the
live workspace. Reloading the page or switching to the demo studio clears those
evidence drafts. Knowledge-base documents are stored separately in PostgreSQL and persist across reloads.

### 4. Customize your knowledge base

Open **Customize Your own knowledge base** to upload documents, paste text, manage
existing sources, and search indexed content. The same knowledge base is available
from the live workspace and demo studio. Follow the dedicated [RAG setup and
pipeline guide below](#rag-pipeline-and-knowledge-base) before indexing.

## Workspace assessment logic

**Run Deflect assessment** answers two questions: what does the available material
support (**Assessment**), and what should the merchant do next (**Recommendation**)?
The live workspace combines a fresh dispute snapshot, merchant-provided evidence,
and retrieved policy passages in one structured OpenAI request. The fixed demo
studio continues to use predefined scenarios.

### Inputs and source attribution

| Input | Included material | Source references |
| --- | --- | --- |
| PayPal dispute | Reason, status, stage, amounts, deadlines, transactions, messages, tracking references, requested evidence, and currently available response options. | `C-*` |
| Merchant input | Evidence notes, carrier, tracking number, and existing refund reference entered in the workspace. | `M-*` |
| Uploaded evidence | Actual PDF/image contents, associated evidence type, and filename. | `E-*` |
| Retrieved policies | Relevant passage text, document name, page number, document ID, and chunk ID. | `P-*` |

Each source also carries an authority label. For example, a buyer message returned
by PayPal has a `C-*` reference but remains a **buyer statement**; it is not a
verified transaction fact. Merchant-entered tracking and refund references remain
merchant statements until supported by records. Previously submitted PayPal
documents are metadata-only unless their contents are separately provided.

### From case to recommendation

```mermaid
flowchart TD
    run["Run Deflect assessment"] --> validate["Validate configuration and evidence upload"]
    validate --> case["Reload dispute from PayPal Sandbox"]
    case --> query["Build query from dispute reason, buyer claim and merchant input"]
    query --> search["Gemini query embedding + pgvector: up to 50 candidates"]
    search --> rerank["Cohere rerank, or vector order with a warning"]
    rerank --> policies["Recheck source eligibility and take top K: default 6"]
    case --> context["Assemble attributed case context"]
    evidence["Merchant notes + actual PDF/image evidence"] --> context
    policies --> context
    context --> model["One OpenAI Responses request with strict JSON schema"]
    model --> checks["Validate fields, citation IDs and allowed action"]
    checks --> review["Assessment, recommendation, evidence checklist and response draft"]
```

1. **Read the current case.** The browser posts evidence groups and attachments to
   `POST /api/disputes/{id}/assessment`. The backend checks the request origin,
   dispute ID, configuration, upload size, field lengths, file associations and
   file formats. It reloads the dispute using server-side PayPal credentials;
   browser-supplied case facts are not used as the authoritative case snapshot.
2. **Retrieve relevant policies.** A template combines the dispute reason and
   stage, buyer statements, requested seller evidence, and merchant notes into a
   query of at most 2,000 characters. Gemini embeds that query, pgvector retrieves
   up to 50 candidates by default, and Cohere reranks the candidates when
   configured. The backend rechecks exact chunk IDs for source eligibility before
   taking the final top K, which defaults to 6 for workspace assessments.
3. **Assemble all case evidence.** Top K limits policy passages; it does not filter
   out this case's uploaded evidence. PDFs are sent as base64 `input_file` parts
   and images as base64 `input_image` parts. Each attachment is associated with an
   evidence source ID. Workspace evidence goes directly into the model request
   and is not indexed into the shared policy knowledge base. LlamaParse remains
   part of policy PDF indexing, rather than this evidence-reading step.
4. **Generate a structured analysis.** One OpenAI request includes the attributed
   sources, attachments, allowed actions, assessment time and retrieval warnings.
   The instructions ask the model to distinguish records from claims, explain
   contradictions and missing information, cite supporting material, and identify
   relevant policies without assuming merchant terms determine PayPal's decision.
   The prompt treats source text and embedded document instructions as data. Findings
   and factual draft paragraphs must reference supplied source IDs. The current
   prompt requests concise English output.
5. **Validate and display the result.** Backend validation checks the response
   shape and field limits, rejects unknown source IDs or duplicate IDs within a
   citation list, requires policy findings to include a policy source, and restricts the recommended
   action to the case's available actions plus internal evidence-gathering/manual
   review steps. The workspace shows the result with clickable source references
   and a copyable response draft for merchant review.

### Assessment and recommendation output

| Output | What the merchant sees |
| --- | --- |
| Case understanding | Summary, buyer's claim, and supported facts with source references. |
| Evidence assessment | Supporting evidence, conflicting or unfavorable evidence, applicable policies, and stated uncertainties. |
| Evidence checklist | Missing materials, why they matter, and high/medium/low priority. |
| Recommendation | One next-step action, its rationale, and new information that could change it. |
| Response draft | Sourced paragraphs for merchant review; the draft can be empty when a supported response cannot be prepared. |
| Traceability | Source text, policy page/chunk references, retrieval query/status, model, timestamp, case update time, and an input snapshot hash. |

For example, if the buyer reports non-delivery and the merchant supplies only a
tracking number, the analysis should identify delivery as unconfirmed and request
carrier delivery records before asserting that the item arrived. A later document
may support delivery or reveal an address mismatch; reassessment should reflect
its contents rather than automatically strengthen the case because a file was
added. Retrieval scores are relevance signals, not win probabilities.

### Reassessment, fallbacks and current limits

Editing notes, tracking details or attachments marks the earlier result
**Needs reassessment**. A refreshed case that differs from the assessed snapshot
also requires reassessment. **Reassess case** reloads the case and repeats retrieval
and analysis using the current inputs. Drafts and the latest assessment remain
separate per case in page-session memory; a new assessment replaces the previous
result. Reloading the page or leaving the live workspace clears them. Durable
evidence storage and assessment history are still planned.

If Cohere is unconfigured or unavailable, retrieval keeps vector ordering and
returns a warning. If policy retrieval fails or returns no passages, the model can
still assess the case and uploaded evidence, with the missing policy grounding
shown as a limitation. OpenAI errors, incomplete responses, refusals and invalid
outputs produce an error that the merchant can retry. PayPal evidence submission
availability does not prevent uploading materials for analysis.

Up to 12 PDF/JPEG/PNG/static GIF files are accepted per assessment, each strictly
below 10 MB and collectively at most 50 MB. The textual source context is bounded;
oversized contexts are rejected rather than silently dropping evidence. Policy
authority, effective dates and geographic applicability are assessed from the
available passage content; the knowledge schema does not establish these facts.
Validation confirms that citation IDs exist, but does not prove that the cited
source supports every generated claim. Merchant review remains necessary, and
assessment does not execute a PayPal action or refund.

### Assessment configuration

Merge these server-side settings from [.env.example](.env.example) into your
existing `.env.local`, replace the API-key placeholder, and restart the server.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | `anyword` placeholder | Required for assessment; missing/placeholder keys are rejected before provider calls. |
| `OPENAI_ASSESSMENT_MODEL` | `gpt-5.4-mini` | Model used for the structured case analysis and evidence reading. |
| `OPENAI_ASSESSMENT_TIMEOUT_MS` | `120000` | OpenAI request timeout in milliseconds. |
| `ASSESSMENT_TOP_K` | `6` | Final number of policy passages supplied to the model; accepts 1–20. |

The model must support the request's image/PDF inputs and Structured Outputs.
Existing knowledge-base settings control the database, embedding model, candidate
count and Cohere reranking. See the [workspace assessment guide](documents/workspace-assessment.md)
for the multipart request contract, source handling and provider details.

## RAG pipeline and knowledge base

Deflect implements the document ingestion, indexing, retrieval, and reranking
stages of RAG. Standalone search returns chunks with document names, page citations,
and relevance scores. The live workspace uses the same retrieval pipeline to ground
OpenAI case assessments in policy sources.
The current application uses one configured knowledge base and has no per-user
knowledge-base access controls.

### Architecture

```mermaid
flowchart TD
    upload["Upload PDF / TXT / Markdown / text"] --> pending["Store original and SHA-256: pending"]
    pending -->|"Process document"| request["HTTP request: one active file per knowledge base"]
    request --> parse["PDF: LlamaParse; text: direct input"]
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
| `t_knowledge_job` | Request processing history, source hash snapshots, progress, leases, and execution/error records. |

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

Start the application:

```bash
npm run dev
```

No separate worker or queue service is needed. Restart the app after changing
environment configuration. Production uses `npm run build` and `npm run start`.
Apply the migrations after upgrading, including `005_request_document_processing.sql`.

The first use binds the embedding model and dimensions to the knowledge base.
Indexing and query both verify that binding, and a database trigger prevents
changing it. To switch embedding models or dimensions, create a new
`KNOWLEDGE_BASE_ID` and index the sources there. Changing the reranker does not
require rebuilding embeddings.

### Indexing and document lifecycle

Upload nonempty PDF, UTF-8 TXT, or Markdown files up to **50 MiB each**, or use
**Paste text**. Saving a source stores it as `pending`; indexing starts only when
the user clicks **Process document**.

```text
Upload -> pending
Process document -> running (the initiating HTTP request executes this file only)
Parse -> Chunk -> Embed -> Store -> success
Processing error, cancellation, or expired request lease -> failed -> manual retry
```

| Action | Behavior |
| --- | --- |
| **Process document** | Reserves the knowledge base's single processing slot and runs parse, chunking, sequential embedding, and persistence in the initiating request. Other process buttons stay disabled until success or failure. Concurrent requests return 409. |
| **Update**, unchanged SHA-256 | Returns **No changes**; preserves the source, version, timestamps, chunks, and vectors. No indexing job is created. |
| **Update**, changed SHA-256 | Checks the current hash with `If-Match`, keeps the document ID, increments the version, deletes old vectors, and returns to `pending` in one transaction. Click **Process document** to rebuild. |
| **Reprocess** | Forces a full rebuild of the stored source, including removal of old vectors, even when its hash is unchanged. |
| **Retry processing** | Manually starts another attempt after a failure. |
| **Delete** | Sets `deleted_at`; retains the original, chunks, vectors, and job history while excluding them from the list and search. Repeated deletion is idempotent. |

Active names are unique within each base. Uploading the same name and bytes is a
no-op; different bytes under an existing name require **Update** by document ID.
After soft deletion, the same name can be uploaded as a new document with a new ID.
There is no restore action in the current UI.

Each processing request has a two-minute lease renewed every 30 seconds. The active run ID,
source hash, and live lease prevent stale requests from publishing results. New
chunks and `success` commit together; a processing failure leaves no old or
partially written index. Deleted documents cannot be reactivated by an in-flight
request. Changed updates are rejected while indexing is running. Stage and embedding
counts persist in PostgreSQL and are shown while processing. Listing documents or
starting processing marks expired attempts and legacy queued attempts as failed;
they require a manual retry and never start another document automatically.

The request stays open until success or failure, with a 15-minute application
deadline. Hosting must allow the complete processing request to finish; removing
the worker does not remove the host's request-duration or upload-size limits.

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
provider contracts. Coverage includes concurrency, rollback, interrupted-request recovery,
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
- A POST link with `rel: provide_evidence` or `provide-evidence` and a nonempty `href`, together with `WAITING_FOR_SELLER_RESPONSE`, enables the submission preview. File selection for analysis remains available independently.

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
separate PayPal actions. The confirmation dialog submits evidence to Sandbox;
formal appeals are not implemented. See
[PayPal's Disputes API guide](https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api/).

### File limits

Following PayPal's
[supported file types and sizes](https://developer.paypal.com/platforms/disputes/reference/supported-file-types-sizes/):

- JPG, JPEG, GIF, PNG, and PDF.
- Nonempty files, each **smaller than 10 MB**.
- Up to **50 MB total** across the selected files for a case.

The local validator checks the extension, the MIME type when the browser supplies
one, and file sizes. The server also checks file signatures. These checks do not
authenticate documents or establish that their contents prove the merchant's claim.

## PayPal evidence submission

The live workspace supports the
[Provide evidence API](https://developer.paypal.com/api/customer-disputes/v1/disputes-provide-evidence),
using the existing Sandbox credentials. The REST app must have Disputes access,
including the `https://uri.paypal.com/services/disputes/update-seller` permission.
The backend sends requests only to the fixed `api-m.sandbox.paypal.com` host.

Run `npm run db:migrate` after updating the application. Migration
[`004_evidence_submissions.sql`](db/migrations/004_evidence_submissions.sql) creates
the durable submission records. Evidence submission requires this database even
when policy retrieval is not being used. No additional API key is required.

### Review and submit

`POST /api/disputes/{id}/evidence` accepts the same multipart `inputs` JSON array and
referenced file parts as assessment. It has two explicitly separated modes:

| Header | Behavior |
| --- | --- |
| `X-Evidence-Mode: preview` (default) | Validates the upload, reloads the case and returns the exact package for review. No evidence POST is sent to PayPal. |
| `X-Evidence-Mode: submit` plus `X-Evidence-Review: <reviewToken>` | Verifies the signed review, uploaded material and current case, then reserves and sends the confirmed submission. |

The confirmation expires after 10 minutes and is bound to the merchant, dispute,
case snapshot, evidence fields and actual attachment bytes. Edits or case changes
require a fresh review. The backend requires `WAITING_FOR_SELLER_RESPONSE`, a
current `provide-evidence` action, and complete evidence for the specific seller
request. Unsupported reasons/types remain subject to manual review. AI output
does not authorize submission or bypass these checks.

The outbound multipart body contains an `input` JSON part and actual binary file
parts. Fulfillment references map to `evidence_info.tracking_info`; an existing
refund reference maps to `evidence_info.refund_ids` and never creates a refund.
Free-form carrier names use PayPal's `OTHER` carrier with `carrier_name_other`.
Files receive unique names such as `evidence-1.pdf` to meet PayPal's filename
constraints and preserve evidence-to-file associations. The preview shows each
original-to-upload filename mapping.

### Receipts and retry handling

After PayPal confirms success with HTTP 200, the application stores a receipt and
reloads the case. A failed refresh still returns the accepted submission receipt.
PostgreSQL stores operation IDs, merchant scope, case/payload hashes, outcome and
receipt metadata; it does not store uploaded evidence contents or evidence notes.

Database constraints prevent concurrent submissions for the same case and repeat
submissions of the same reviewed package. Repeating a completed confirmation
returns its stored receipt. Explicit provider rejections require a new review
before an intentional retry. Evidence POSTs are never automatically retried.
Timeouts, connection failures and ambiguous provider responses retain a blocking
`pending` or `unknown` record. An operator must verify the case in PayPal and
reconcile that record before allowing another submission; there is no automatic
expiry or UI override for uncertain operations.

This submits evidence only. Formal appeals, claim acceptance, refunds and other
financial actions are separate integrations. The application still uses one
configured Sandbox merchant and does not provide production application authentication.

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
        → Next.js /api/disputes/{id}/assessment → Policy retrieval + OpenAI
        → Next.js /api/disputes/{id}/evidence → Merchant-confirmed Sandbox evidence
```

| Endpoint | Response |
| --- | --- |
| `GET /api/disputes` | `items`, `fetchedAt`, and `environment: sandbox`; first list page only. |
| `GET /api/disputes/{id}` | Normalized `dispute` details, `fetchedAt`, and `environment: sandbox`. |
| `POST /api/disputes/{id}/assessment` | Cited assessment and recommendation, source snapshot, retrieval diagnostics, warnings and model metadata. |
| `POST /api/disputes/{id}/evidence` | Server-validated preview or a confirmed Sandbox evidence receipt and refreshed case. |

The Disputes client obtains and caches an OAuth token, shares concurrent token
requests, and retries a GET once after a rejected token. IDs are validated before
querying PayPal. Dispute responses use `private, no-store`, and provider errors
are sanitized. Credentials and tokens are not returned to the browser. The
Disputes client uses a fixed Sandbox host and never follows provider-supplied URLs.
It performs case reads and the explicitly confirmed `provide-evidence` POST only.

The API detail response retains operational fields for future backend work;
the frontend chooses the customer support fields to display. Knowledge-base upload,
update, soft deletion, indexing, and reranked search endpoints are implemented
separately. PayPal evidence submission uses its own confirmation and receipt flow;
other dispute mutations and appeal endpoints remain planned integrations.

| File | Responsibility |
| --- | --- |
| [app/live-dispute-workspace.tsx](app/live-dispute-workspace.tsx) | Live case list, customer context, selection, and case drafts. |
| [app/dispute-evidence.tsx](app/dispute-evidence.tsx) | Evidence fields, file lists, assessment results, server review and submission confirmation. |
| [app/case-assessment.tsx](app/case-assessment.tsx) | Assessment findings, recommendation, cited draft, source navigation and reassessment status. |
| [lib/assessment/](lib/assessment/) | Bounded uploads, case context, policy search query, OpenAI request and structured output validation. |
| [lib/evidence/](lib/evidence/) | Evidence packaging, signed reviews, case checks, durable duplicate protection and submission orchestration. |
| [lib/dispute-evidence.ts](lib/dispute-evidence.ts) | Baseline evidence rules, draft checks, and file validation. |
| [lib/disputes.ts](lib/disputes.ts) | Shared types and normalization of PayPal responses. |
| [lib/paypal-disputes.ts](lib/paypal-disputes.ts) | Server-only facade and sanitized API error responses. |
| [lib/paypal-disputes-client.ts](lib/paypal-disputes-client.ts) | OAuth, dispute reads and a non-retrying Sandbox evidence POST. |
| [app/dispute-workspace.tsx](app/dispute-workspace.tsx) | Mode switching and the static demo studio. |
| [app/knowledge-base.tsx](app/knowledge-base.tsx) | Document management, indexing controls, status polling, and search results. |
| [lib/knowledge/](lib/knowledge/) | Configuration, PostgreSQL repository, document validation, providers, request processing, retrieval, and reranking. |
| [lib/knowledge/processing.ts](lib/knowledge/processing.ts) | Selected-document parse/chunk/embed/persist pipeline, awaited by the initiating request. |
| [db/migrations/](db/migrations/) | Repeatable PostgreSQL and pgvector schema migrations. |
| [tests/paypal-disputes.test.ts](tests/paypal-disputes.test.ts) | Mocked API client, normalization, evidence, and file checks. |
| [tests/knowledge-base.test.ts](tests/knowledge-base.test.ts) | PostgreSQL/pgvector storage, document lifecycle, single-file admission, request recovery, and retrieval eligibility tests. |
| [tests/knowledge-rerank.test.ts](tests/knowledge-rerank.test.ts) | Rerank API contract, result mapping, fallback, timeout, and cancellation checks. |
| [tests/case-assessment.test.ts](tests/case-assessment.test.ts) | Assessment input limits, actual attachment transmission, source integrity, action availability and provider failure handling. |
| [tests/paypal-evidence.test.ts](tests/paypal-evidence.test.ts) | Multipart evidence, review binding, durable duplicate protection, provider rejections and uncertain submission outcomes. |

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
| `npm run test:knowledge` | Test PostgreSQL/pgvector storage, document lifecycle, processing recovery, and retrieval/reranking with mocked providers. |
| `npm run test:assessment` | Test assessment uploads, source context, OpenAI contract, citations, fallback and cancellation with mocked providers. |
| `npm run test:evidence` | Test evidence review/submission with PGlite and mocked PayPal; never sends real evidence. |
| `npm run db:migrate` | Initialize the knowledge-base and evidence-submission schemas and pgvector extension. |
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
| PayPal submission is unavailable | The case must be awaiting the seller's response and offer a POST evidence link. Files can still be added for analysis. |
| OpenAI is not configured | Replace `OPENAI_API_KEY=anyword` in `.env.local` with a real key and restart the app. |
| Assessment has no policy grounding | Check the visible retrieval warning, indexed documents, database and Gemini configuration. |
| Assessment requests more evidence | Follow the missing-field suggestions; refund and tracking evidence need their structured references where required. |
| Submission confirmation is disabled | A successful server review, current seller request and complete supported evidence fields are required. |
| Evidence submission records are unavailable | Check PostgreSQL and run `npm run db:migrate` to create the evidence-submission table. |
| Evidence submission result is uncertain | Verify the case in PayPal before reconciling its pending/unknown record. Do not blindly resend. |
| Files disappeared | Drafts are in-memory and reset on reload or when leaving the live workspace. |
| Timeout or rate limit | Check server connectivity to PayPal; wait before retrying a rate-limited request. |
| Knowledge database is unavailable | Start PostgreSQL, check `DATABASE_URL`, and apply `npm run db:migrate` with pgvector available. |
| A knowledge document stays `running` | Refresh the knowledge base after the two-minute request lease expires. Listing recovers interrupted attempts as failed; click **Retry processing**. Check the host's execution limit if requests are repeatedly terminated. |
| Search shows a vector-only warning | Configure `COHERE_API_KEY` and restart the app, or check the reported Cohere credentials, quota, model, and timeout error. |
| A knowledge document has no search hits | Confirm indexing reached `success`, the document is not soft-deleted, and the configured embedding binding matches. |

## Planned integrations

The intended flow is:

```text
Read dispute → Query order and carrier facts → LLM recommendation
             → Policy / JEV validation → Execute action → Persist audit log
```

The current implementation covers dispute reads, evidence preparation, local rule
checks, cited OpenAI assessments using policy retrieval, and merchant-confirmed
Sandbox evidence submission. Remaining work includes order/carrier queries,
Policy/JEV validation, other PayPal actions,
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
