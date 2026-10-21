import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDisputeDetail } from "../lib/disputes";
import { getAssessmentConfig } from "../lib/assessment/config";
import { allowedAssessmentActions, buildAssessmentContext, buildRetrievalQuery } from "../lib/assessment/context";
import { readAssessmentUpload, readEvidenceBytes, requireAssessmentOrigin, type AssessmentUpload, type MerchantEvidenceInput } from "../lib/assessment/input";
import { ASSESSMENT_INSTRUCTIONS, requestOpenAIAssessment } from "../lib/assessment/openai";
import { validateAssessment } from "../lib/assessment/output";
import { assessCase } from "../lib/assessment/service";
import { getEmbeddingConfig } from "../lib/knowledge/config";
import type { CaseAssessment, CitedStatement } from "../lib/assessment/types";
import type { KnowledgeSearchResult, SearchHit } from "../lib/knowledge/types";

const config = getAssessmentConfig({ OPENAI_API_KEY: "test-key" });
const signal = () => new AbortController().signal;
const dispute = () => normalizeDisputeDetail({
  dispute_id: "PP-R-TEST", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE",
  update_time: "2026-10-21T12:00:00Z", dispute_amount: { currency_code: "USD", value: "10.00" },
  messages: [{ posted_by: "BUYER", content: "My order has not arrived. Please refund." }],
  evidences: [{ source: "SUBMITTED_BY_SELLER", documents: [{ name: "previous-proof.pdf" }] }],
  links: [{ rel: "send-message", method: "POST", href: "https://example.invalid/message" }],
});
const emptyUpload = (): AssessmentUpload => ({ inputs: [], files: new Map() });
const input = (extra: Partial<MerchantEvidenceInput> = {}): MerchantEvidenceInput => ({ type: "OTHER", notes: "Tracking is available, delivery unconfirmed.", carrier: "UPS", trackingNumber: "TRACK-1", refundReference: "", fileKeys: [], ...extra });
const hit: SearchHit = { id: "chunk-test", docId: "doc-test", documentName: "Shipping policy.pdf", pageNumber: 2, content: "Retain delivery records when responding to a non-delivery dispute.", score: 0.8 };
const knowledge = (hits: SearchHit[] = [hit]): KnowledgeSearchResult => ({ knowledgeBase: { id: "default", embeddingModel: "test", embeddingDimensions: 3 }, hits, retrieval: { rerankStatus: "applied", rerankerModel: "test-rerank", candidateCount: hits.length, warning: null } });
const statement = (text = "The buyer reports non-delivery.", sourceIds = ["C-message-1"]): CitedStatement => ({ text, sourceIds });
function assessment(): CaseAssessment {
  return {
    summary: statement(), buyerClaim: statement(), supportedFacts: [statement("Case amount: USD 10.00.", ["C-amounts"])],
    supportingEvidence: [], conflictingEvidence: [], applicablePolicies: [],
    missingEvidence: [{ item: "Delivery confirmation", why: "Delivery is not confirmed in the available records.", priority: "high", sourceIds: ["C-case"] }],
    uncertainties: ["Delivery status is unknown."],
    recommendation: { action: "gather_evidence", title: "Collect delivery records", rationale: [statement()], responseDraft: [statement("We have noted your report that the order has not arrived.")], reconsiderWhen: ["A carrier delivery record becomes available."] },
  };
}
const completed = (value: unknown = assessment()) => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
function multipart(inputs: unknown, files: [string, File][] = []) {
  const form = new FormData(); form.set("inputs", JSON.stringify(inputs));
  for (const [key, file] of files) form.append(key, file);
  return new Request("http://localhost/api/disputes/PP-R-TEST/assessment", { method: "POST", body: form });
}

test("placeholder credentials fail locally; model, timeout and top K are configurable", () => {
  assert.throws(() => getAssessmentConfig({ OPENAI_API_KEY: "anyword" }), { code: "OPENAI_NOT_CONFIGURED" });
  assert.equal(config.model, "gpt-5.4-mini");
  assert.equal(config.topK, 6);
  assert.equal(getAssessmentConfig({ OPENAI_API_KEY: "test", ASSESSMENT_TOP_K: "8" }).topK, 8);
  assert.throws(() => getAssessmentConfig({ OPENAI_API_KEY: "test", ASSESSMENT_TOP_K: "21" }), { code: "INVALID_ASSESSMENT_CONFIG" });
  assert.deepEqual(getEmbeddingConfig({ GEMINI_API_KEY: "gemini-test" }), { geminiKey: "gemini-test" });
});

test("same-origin requests use the HTTP Host even when Next canonicalizes the URL; cross-site requests fail", () => {
  const request = (origin: string, site = "same-origin") => new Request("http://localhost:3107/assessment", { headers: { host: "127.0.0.1:3107", origin, "sec-fetch-site": site } });
  assert.doesNotThrow(() => requireAssessmentOrigin(request("http://127.0.0.1:3107")));
  assert.throws(() => requireAssessmentOrigin(request("https://unrelated.example")), { code: "ORIGIN_NOT_ALLOWED" });
  assert.throws(() => requireAssessmentOrigin(request("http://127.0.0.1:3107", "cross-site")), { code: "ORIGIN_NOT_ALLOWED" });
});

test("multipart inputs preserve file-to-evidence associations and reject orphaned, duplicate or missing attachments", async () => {
  const pdf = new File(["%PDF-1.7\nexample"], "proof.pdf", { type: "application/pdf" });
  const parsed = await readAssessmentUpload(multipart([input({ fileKeys: ["file-1"] })], [["file-1", pdf]]));
  assert.equal(parsed.files.get("file-1")?.name, "proof.pdf");
  assert.equal(parsed.inputs[0].trackingNumber, "TRACK-1");
  await assert.rejects(readAssessmentUpload(multipart([input({ fileKeys: ["file-1"] })])), { code: "INVALID_ASSESSMENT_INPUT" });
  await assert.rejects(readAssessmentUpload(multipart([], [["file-1", pdf]])), { code: "INVALID_ASSESSMENT_INPUT" });
  await assert.rejects(readAssessmentUpload(multipart([input(), input()])), { code: "INVALID_ASSESSMENT_INPUT" });
  await assert.rejects(readAssessmentUpload(multipart([input({ fileKeys: ["file-1", "file-1"] })], [["file-1", pdf]])), { code: "INVALID_ASSESSMENT_INPUT" });
  await assert.rejects(readAssessmentUpload(multipart([input({ notes: "x".repeat(2001) })])), { code: "INVALID_ASSESSMENT_INPUT" });
});

test("request size is bounded even without a Content-Length header", async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(50_256_001)); controller.close(); } });
  const request = new Request("http://localhost/assessment", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=test" }, body, duplex: "half" } as RequestInit);
  await assert.rejects(readAssessmentUpload(request), { code: "ASSESSMENT_TOO_LARGE" });
});

test("file signatures are checked before model input; animated GIFs are rejected", async () => {
  await assert.rejects(readEvidenceBytes(new File(["plain text"], "fake.pdf", { type: "application/pdf" })), { code: "INVALID_EVIDENCE_FILE" });
  await assert.rejects(readEvidenceBytes(new File(["GIF89aNETSCAPE2.0"], "animated.gif", { type: "image/gif" })), { code: "ANIMATED_GIF_UNSUPPORTED" });
});

test("case sources distinguish buyer statements, merchant claims, metadata and full attachments; hashes change with evidence", async () => {
  const pdf = new File(["%PDF-1.7\nproof"], "proof.pdf", { type: "application/pdf" });
  const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])], "photo.png", { type: "image/png" });
  const upload = { inputs: [input({ fileKeys: ["file-1", "file-2"] })], files: new Map([["file-1", pdf], ["file-2", png]]) };
  const context = await buildAssessmentContext(dispute(), upload, [hit]);
  assert.equal(context.sources.find((source) => source.id === "C-message-1")?.authority, "buyer_statement");
  assert.equal(context.sources.find((source) => source.id === "M-1")?.authority, "merchant_statement");
  assert.match(context.sources.find((source) => source.id === "C-document-1")!.content, /Metadata only/);
  assert.equal(context.sources.find((source) => source.id === "P-1")?.pageNumber, 2);
  const filePart = context.attachments.find((part) => part.type === "input_file");
  assert.ok(filePart && filePart.type === "input_file");
  assert.equal(filePart.file_data, `data:application/pdf;base64,${Buffer.from(await pdf.arrayBuffer()).toString("base64")}`);
  assert.equal(context.attachments.filter((part) => part.type === "input_image").length, 1);
  assert.equal(context.sources.filter((source) => source.kind === "evidence").length, 2);
  const repeated = await buildAssessmentContext(dispute(), upload, [hit]);
  assert.equal(context.snapshotHash, repeated.snapshotHash);
  const changedFile = await buildAssessmentContext(dispute(), { ...upload, files: new Map([["file-1", new File(["%PDF-1.7\nnew proof"], "proof.pdf", { type: "application/pdf" })], ["file-2", png]]) }, [hit]);
  assert.notEqual(context.snapshotHash, changedFile.snapshotHash);
  const changed = await buildAssessmentContext(dispute(), { ...upload, inputs: [input({ notes: "New merchant facts", fileKeys: ["file-1", "file-2"] })] }, [hit]);
  assert.notEqual(context.snapshotHash, changed.snapshotHash);
  assert.ok(!JSON.stringify(context.sources).includes("example.invalid"));
});

test("retrieval queries retain dispute reason and evidence topics when statements are long", () => {
  const current = dispute(); current.messages[0].content = "x".repeat(10000);
  const query = buildRetrievalQuery(current, [input({ notes: "y".repeat(2000) })]);
  assert.ok(query.length <= 2000);
  assert.match(query, /MERCHANDISE_OR_SERVICE_NOT_RECEIVED/);
  assert.match(query, /Find applicable PayPal/);
  assert.match(query, /delivery not verified/);
});

test("case actions are normalized and unavailable evidence submission cannot be recommended", async () => {
  const current = dispute(); current.availableActions.push("provide_evidence");
  assert.deepEqual(allowedAssessmentActions(current), ["gather_evidence", "manual_review", "send_message"]);
  const context = await buildAssessmentContext(current, emptyUpload(), []);
  const invalid = assessment(); invalid.recommendation.action = "accept_claim";
  assert.throws(() => validateAssessment(invalid, context.sources, context.allowedActions), { code: "INVALID_ASSESSMENT_RESPONSE" });
});

test("unknown citations, unsupported policy sources and malformed fields are rejected", async () => {
  const context = await buildAssessmentContext(dispute(), emptyUpload(), []);
  for (const mutate of [
    (value: CaseAssessment) => { value.summary.sourceIds = ["made-up-source"]; },
    (value: CaseAssessment) => { value.applicablePolicies = [statement("A merchant policy applies.", ["C-case"])]; },
    (value: CaseAssessment) => { value.recommendation.rationale = []; },
    (value: CaseAssessment) => { value.buyerClaim.sourceIds = []; },
    (value: CaseAssessment) => { value.summary.text = ""; },
  ]) {
    const value = assessment(); mutate(value);
    assert.throws(() => validateAssessment(value, context.sources, context.allowedActions), { code: "INVALID_ASSESSMENT_RESPONSE" });
  }
});

test("Responses request uses strict output, source context, full file data, server credentials and store:false", async () => {
  const pdf = new File(["%PDF-1.7\nproof bytes"], "proof.pdf", { type: "application/pdf" });
  const context = await buildAssessmentContext(dispute(), { inputs: [input({ fileKeys: ["file-1"] })], files: new Map([["file-1", pdf]]) }, [hit]);
  const result = await requestOpenAIAssessment(context, [], "2026-10-21T12:00:00Z", config, signal(), async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(body.text.format.schema.properties.recommendation.properties.action.enum, context.allowedActions);
    assert.match(body.instructions, /untrusted DATA/);
    assert.ok(!body.instructions.includes(dispute().messages[0].content));
    assert.match(body.input[0].content[0].text, /C-message-1/);
    assert.equal(body.input[0].content.find((part: { type: string }) => part.type === "input_file").file_data, `data:application/pdf;base64,${Buffer.from(await pdf.arrayBuffer()).toString("base64")}`);
    return completed();
  });
  assert.equal(result.recommendation.action, "gather_evidence");
  assert.match(ASSESSMENT_INSTRUCTIONS, /Never invent tracking/);
});

test("orchestration retrieves configured top K and returns citations and a reproducible snapshot", async () => {
  const result = await assessCase(dispute(), emptyUpload(), config, signal(), async (query, limit) => {
    assert.match(query, /not arrived/); assert.equal(limit, 6); return knowledge();
  }, async () => completed());
  assert.equal(result.retrieval.hitCount, 1);
  assert.equal(result.sources.find((source) => source.kind === "policy")?.chunkId, "chunk-test");
  assert.equal(result.caseUpdatedAt, dispute().updatedAt);
  assert.equal(result.snapshotHash.length, 64);
});

test("unavailable/empty policy retrieval is explicit and does not fabricate policy grounding", async () => {
  const unavailable = await assessCase(dispute(), emptyUpload(), config, signal(), async () => { throw new Error("private DATABASE_URL and password"); }, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.match(body.input[0].content[0].text, /retrieval is unavailable/);
    return completed();
  });
  assert.equal(unavailable.retrieval.status, "unavailable");
  assert.ok(!JSON.stringify(unavailable).includes("password"));
  assert.equal(unavailable.sources.filter((source) => source.kind === "policy").length, 0);
  const empty = await assessCase(dispute(), emptyUpload(), config, signal(), async () => knowledge([]), async () => completed());
  assert.match(empty.warnings.join(" "), /No indexed policy/);
});

test("provider errors, incomplete output and refusals are safe, actionable failures", async () => {
  const context = await buildAssessmentContext(dispute(), emptyUpload(), []);
  await assert.rejects(requestOpenAIAssessment(context, [], "now", config, signal(), async () => new Response("secret payload", { status: 401 })), (error: unknown) => {
    assert.match((error as Error).message, /HTTP 401/);
    assert.ok(!(error as Error).message.includes("secret payload")); return true;
  });
  await assert.rejects(requestOpenAIAssessment(context, [], "now", config, signal(), async () => Response.json({ status: "incomplete", output: [] })), { code: "ASSESSMENT_INCOMPLETE" });
  await assert.rejects(requestOpenAIAssessment(context, [], "now", config, signal(), async () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "refusal" }] }] })), { code: "ASSESSMENT_REFUSED" });
  await assert.rejects(requestOpenAIAssessment(context, [], "now", config, signal(), async () => { throw new Error("test-key private exception"); }), { code: "OPENAI_UNAVAILABLE" });
});

test("cancellation during retrieval prevents a model request", async () => {
  const controller = new AbortController();
  let modelCalled = false;
  await assert.rejects(assessCase(dispute(), emptyUpload(), config, controller.signal, async () => { controller.abort(); throw new Error("cancel"); }, async () => { modelCalled = true; return completed(); }), { name: "AbortError" });
  assert.equal(modelCalled, false);
});
