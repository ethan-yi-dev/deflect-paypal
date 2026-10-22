# Workspace assessment

The live workspace combines a fresh PayPal dispute snapshot, merchant notes and
actual PDF/image attachments, and relevant indexed policy passages in a single
OpenAI Responses request. The fixed demo studio continues to use display fixtures.

## Configuration

Merge these fields from `.env.example` into your existing `.env.local` and restart
Next.js. Keep existing PayPal and knowledge-base settings.

```dotenv
OPENAI_API_KEY=anyword
OPENAI_ASSESSMENT_MODEL=gpt-5.4-mini
OPENAI_ASSESSMENT_TIMEOUT_MS=120000
ASSESSMENT_TOP_K=6
```

Replace `anyword` with your API key. The server rejects missing/placeholder keys
before reading attachments or calling providers. The model must support image/PDF
inputs and Structured Outputs. Keys never use a `NEXT_PUBLIC_` prefix.

Policy retrieval uses the existing PostgreSQL/pgvector store and Gemini embeddings.
Cohere reranking is optional. LlamaParse is required for indexing policy PDFs, but
is not required for querying or reading workspace evidence. Missing/unavailable
policy retrieval is shown as a limitation; case analysis can still proceed.

## Request and analysis

`POST /api/disputes/[id]/assessment` accepts multipart form data:

- `inputs`: JSON array of evidence groups (`type`, `notes`, `carrier`,
  `trackingNumber`, `refundReference`, `fileKeys`).
- Files under the keys referenced in `fileKeys`, such as `file-1`.

The server checks origin, bounds the body even without `Content-Length`, validates
the field lengths, file associations, sizes and signatures, and reloads the dispute
using server-side PayPal credentials. Browser-supplied case facts are not accepted.

The retrieval query combines the dispute reason, buyer claim, requested evidence,
and merchant notes. Existing vector retrieval and reranking return the final top K.
All case evidence is included independently of that policy ranking. Up to 12 files
are accepted, each strictly below 10 MB and collectively at most 50 MB. Supported
formats are PDF, JPEG, PNG and static GIF. Unreadable attachments produce model
limitations or a provider error; no filename-only analysis substitutes for contents.

PDFs use base64 `input_file`; images use base64 `input_image`. Evidence is sent to
OpenAI only when assessment is requested, and is not added to the policy knowledge
base. Responses use `store: false`; this is not a claim of zero provider retention.
See [OpenAI file inputs](https://developers.openai.com/api/docs/guides/file-inputs)
and [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

## Output and review

The strict JSON result includes summary, buyer claim, supported facts, supporting
and conflicting evidence, applicable policies, prioritized missing evidence,
uncertainties, one recommendation, a response draft, and conditions for reassessment.
Backend validation checks the output shape, source IDs, policy citations, and
case-specific action availability. It does not prove that a citation entails a
claim; the merchant must review the analysis and draft.

Source IDs distinguish PayPal records (`C-*`), merchant statements (`M-*`), uploaded
evidence (`E-*`), and retrieved policy passages (`P-*`). Policy passages preserve
document/chunk IDs, page and text. Policy authority and historical applicability
are assessed from the content; the current knowledge schema does not establish
platform-vs-merchant authority or historical effective dates. Previously submitted
PayPal files remain metadata-only unless their contents are separately provided.

The result retains source text, retrieval diagnostics, model, timestamp, case update
time and a SHA-256 hash of the input snapshot including attachment hashes. Notes,
files and the latest result remain in page-session memory per case. Editing the
draft or refreshing into a changed case marks the earlier result for reassessment;
reloading the page clears them. Durable evidence storage and assessment history
are not implemented by this workflow.

Uploads remain available when PayPal evidence submission is unavailable. Analysis
does not execute a PayPal action. The separate evidence confirmation flow can
submit the reviewed notes, references and files to PayPal Sandbox; see
[PayPal evidence submission](../README.md#paypal-evidence-submission).
Run `npm run test:assessment` for mocked provider and input validation tests.
