# Deflect: AI-Powered Dispute Resolution Assistant for PayPal Merchants

**Tagline:** Turn dispute details, order facts, and merchant policies into clear, evidence-backed response recommendations.

## Hackathon Submission Overview

### Inspiration

Small merchants often handle payment disputes without a dedicated disputes team. Relevant information is scattered across payment records, order systems, shipping updates, customer messages, and merchant policies. The quality of a response can depend heavily on the experience of the person handling the case.

We wanted to help merchants build a clearer understanding of each dispute, identify missing evidence, and prepare a consistent, well-supported response. Deflect focuses on disputes that have already been opened, giving merchants practical guidance while keeping them in control of submissions and financial actions.

### What it does

Deflect is being built as an AI-assisted workspace for PayPal disputes. Its workflow brings together dispute details, order and shipping facts, and uploaded evidence to recommend a response strategy, explain the reasoning, and draft a merchant response. Merchants can add evidence and request a fresh assessment as the case develops.

The next planned addition is a merchant-specific policy knowledge base powered by Retrieval-Augmented Generation (RAG). Deflect will retrieve relevant clauses from each merchant's own policies and cite them in its analysis, helping merchants prepare responses grounded in their actual terms and the facts of the case.

### How we built it

We are building a TypeScript application around PayPal Sandbox dispute data and an LLM for case analysis and response drafting. The backend assembles the case context, separates verified records from customer claims, and validates proposed actions before execution. A simple merchant dashboard will support dispute selection, evidence review, reassessment, and response approval.

The planned RAG pipeline will parse and index merchant policy documents, retrieve relevant sections for each case, and include those sections with source references in the model's context. A structured evaluation interface will support additional assessment components, including a planned TypeSafe AI JEV integration.

### Challenges we ran into

The main challenge is giving useful guidance when the available evidence is incomplete or contradictory. A delivery status, a customer statement, and a policy clause may each describe a different part of the situation. The assistant must explain what is supported, what remains uncertain, and what evidence would help resolve that uncertainty.

Other challenges include linking PayPal transactions to merchant orders, grounding recommendations in documents, handling changing case information, and ensuring that an AI-generated suggestion does not become an unreviewed submission or financial action.

### Accomplishments that we're proud of

We have established a PayPal Sandbox purchase and dispute scenario and defined a focused merchant workflow around it. We are proud of moving the product toward a practical sequence: understand the case, identify evidence gaps, prepare a response, and reassess when new information arrives.

The design connects recommendations to their supporting facts and keeps merchant approval explicit. This gives us a concrete foundation for building an evidence-backed dispute assistant.

### What we learned

A useful dispute assistant needs more than fluent writing. It needs reliable case facts, relevant policies, source references, and a clear explanation of uncertainty. Merchant policies can provide context, but they do not establish what happened or determine the payment platform's decision.

We also learned to separate recommendation quality from execution authority. AI can analyze and draft; the merchant reviews the response, and backend checks govern any external action.

### What's next for Deflect

Our next priority is merchant-specific policy RAG: allowing merchants to upload their delivery, return, refund, cancellation, and other relevant policies, then retrieving and citing the applicable clauses during case analysis.

We will complete the dispute-to-response workflow, add evidence upload and reassessment, integrate JEV into the structured evaluation layer, and introduce webhook-driven case updates and audit history. We will also test whether new evidence changes recommendations appropriately and whether policy citations actually support the generated claims.

Later, real merchant outcomes could help us evaluate response quality and calibrate any outcome estimates. Customer interaction history and preferences may become supporting context, while the immediate focus remains evidence quality and merchant-specific policy grounding.

---

## Detailed Project Description

### The Problem

When a PayPal dispute arrives, a small merchant needs to understand the buyer's claim, find the relevant records, decide how to respond, and prepare supporting evidence.

Those tasks can involve several systems and documents. A tracking update may live in a shipping tool, a refund record in a payment system, and a return condition in a policy PDF. Less experienced staff may overlook useful evidence or prepare a response that does not address the actual dispute reason.

Deflect aims to make that work more consistent by organizing the case and helping the merchant answer four questions:

1. What does the available evidence support?
2. What information is missing or contradictory?
3. What response is reasonable for this case?
4. How should the merchant explain that response and support it with evidence?

### What Deflect Does

Deflect is an AI-assisted dispute resolution workspace for PayPal merchants. Its target workflow starts with an existing dispute and produces a reviewable response recommendation.

#### 1. Load the dispute

The merchant selects a PayPal dispute. Deflect retrieves the available case details, including the dispute reason, transaction reference, buyer statements, current status, and any available response deadline or action information.

#### 2. Assemble the case facts

The backend links the dispute to available order, payment, shipping, return, and refund records. Merchants can also provide documents and customer communications.

The case context distinguishes between:

- facts supported by records;
- buyer or merchant statements;
- information extracted from uploaded documents;
- missing information and unresolved contradictions.

A tracking status alone should not silently become a conclusion that the buyer's claim is false. The assistant must explain the limits of the available evidence.

#### 3. Retrieve the merchant's relevant policies — planned RAG addition

Each merchant will be able to maintain a separate policy knowledge base containing documents such as:

- shipping and delivery policies;
- return and refund policies;
- damaged, incorrect, or missing-item policies;
- order cancellation policies;
- subscription or recurring-order terms, where applicable;
- customer support and complaint-handling procedures.

Documents will be parsed, divided into retrievable sections, and indexed before case analysis. Retrieval will select relevant passages using the dispute reason and case facts, rather than inserting every policy document into every model request.

Retrieved passages will retain source information such as document name, section, and policy version or effective date when available. The system should use the version applicable to the transaction where that can be established; missing historical policies should be surfaced as a limitation.

Merchant policies, payment-platform requirements, and transaction evidence will remain distinct sources. The assistant should flag conflicting terms or missing facts instead of assuming that a merchant policy settles the dispute.

#### 4. Generate a structured assessment

The AI assessment will explain:

- the buyer's claim;
- supporting and conflicting evidence;
- relevant merchant policy clauses, once RAG is integrated;
- missing documents or facts;
- a recommended response strategy;
- the reasoning and uncertainty behind that recommendation.

Possible strategies include providing fulfillment evidence, clarifying a return or refund timeline, requesting additional information, considering a refund or settlement, or escalating the case for manual review.

The assessment should help a merchant choose a response. It should not automatically label a buyer as dishonest or treat a model score as proof.

#### 5. Prepare a response draft and evidence checklist

Deflect will turn the assessment into a merchant-reviewable response draft and a checklist of supporting materials. Claims in the draft should connect to case records or cited policy passages.

The system must not invent tracking numbers, refund identifiers, signatures, delivery confirmations, or supporting documents. If a claim needs evidence that is unavailable, it should identify that gap before submission.

#### 6. Reassess when evidence changes

A merchant can upload a new document, add a record, or correct case information and run another assessment.

Each reassessment will use the updated case context and identify what changed, which conclusions were affected, and which uncertainties remain. Earlier assessments will be retained in the case history.

#### 7. Review, validate, and act

The merchant reviews the recommendation, draft, and evidence before approving an external action. Backend checks will validate permissions, current case state, supported actions, and duplicate-operation protection.

Any enabled refund action will require separate authorization and financial validation. The exact available PayPal action must be checked against the current case and API response.

### Policy Grounding and Action Controls

Deflect uses two distinct layers:

| Layer | Purpose |
| --- | --- |
| Merchant policy RAG | Retrieve relevant terms and provide cited context for analysis and drafting. |
| Backend action controls | Validate authorization, current state, required inputs, and duplicate-operation protection before an external action. |

Retrieved documents and customer messages are source material, not instructions that can grant execution permission. A policy passage cannot authorize a refund or bypass merchant review.

The planned JEV integration belongs in the structured evaluation layer. Backend validation remains responsible for enforcing action permissions and execution constraints.

### Explainability and Audit History

Each assessment will retain the case facts, evidence references, retrieved policy passages and versions, recommendation, response draft, and stated uncertainties.

For approved actions, the audit history will also record the merchant's approval, backend validation results, and the PayPal execution result. This allows the merchant to trace a recommendation back to the information available when it was generated.

### Technology and Implementation Direction

| Component | Role |
| --- | --- |
| TypeScript application | Backend orchestration and merchant dashboard. |
| PayPal Sandbox | Development and testing with purchase and dispute scenarios. |
| PayPal Disputes API integration | Retrieve case data and support approved responses where available. |
| LLM | Analyze case context and generate structured recommendations and response drafts. |
| Merchant policy RAG — planned | Parse, index, retrieve, and cite merchant-specific policy documents. |
| TypeSafe AI JEV — planned | Add structured evaluation to the recommendation workflow. |
| Evidence storage and case history | Preserve uploaded materials and successive assessments. |
| Backend validation and audit log | Control external actions and record their authorization and results. |

### Target Demo

The demo will use a PayPal Sandbox dispute and synthetic merchant records.

1. A sandbox buyer completes a purchase and opens a dispute.
2. The merchant selects the case in Deflect.
3. Deflect retrieves the case and links available order and shipping records.
4. With RAG integrated, Deflect retrieves relevant merchant policy clauses.
5. The assistant explains the available evidence, identifies missing materials, and drafts a response.
6. The merchant adds a new piece of evidence and runs a fresh assessment.
7. Deflect explains how the new evidence affects the recommendation.
8. The merchant reviews and approves the response; any supported Sandbox submission is validated and logged.

For example, an initial case may contain only an ambiguous tracking update. Adding a carrier document may strengthen part of the response or reveal an address mismatch. The second assessment should reflect that evidence rather than simply increase a score because another file was uploaded.

### Prototype Scope and Evaluation

The project is in development. Merchant policy RAG, JEV integration, and the complete review-and-submission workflow are planned additions; this description does not present them as completed features.

The prototype will prioritize evidence completeness, citation accuracy, factual consistency, and useful next steps. Any displayed outcome score will be labeled as an illustrative assessment until it has been calibrated and evaluated against real resolved cases.

Success can initially be measured through preparation time, unsupported-claim frequency, policy retrieval quality, and whether reassessments respond correctly to new evidence. Real dispute outcomes can support later evaluation, without treating an AI recommendation as a guarantee of the platform's decision.

**Deflect's core principle:** Facts support the case. Policies provide context. AI recommends. Merchants approve. Code validates.
