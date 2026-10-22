import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { normalizeDisputeDetail } from "../lib/disputes";
import type { AssessmentUpload, MerchantEvidenceInput } from "../lib/assessment/input";
import { createPayPalDisputesClient, PayPalEvidenceError } from "../lib/paypal-disputes-client";
import { createEvidenceReview, evidenceCredentials, evidenceMultipart, packageEvidence, readEvidenceReview, validateEvidenceForCase } from "../lib/evidence/package";
import { EvidenceSubmissionRepository } from "../lib/evidence/repository";
import { previewEvidence, submitEvidence, type EvidenceDependencies } from "../lib/evidence/service";
import type { Database } from "../lib/knowledge/database";

let pg: PGlite;
let db: Pick<Database, "query">;
const credentials = { clientId: "test-merchant", secret: "test-secret" };
const currentTime = Date.parse("2026-10-21T12:00:00Z");
const signal = () => new AbortController().signal;
const evidenceInput = (extra: Partial<MerchantEvidenceInput> = {}): MerchantEvidenceInput => ({ type: "PROOF_OF_FULFILLMENT", notes: "Please review the shipment record.", carrier: "", trackingNumber: "", refundReference: "", fileKeys: [], ...extra });
const upload = (extra: Partial<MerchantEvidenceInput> = {}): AssessmentUpload => ({ inputs: [evidenceInput(extra)], files: new Map() });
const currentCase = () => normalizeDisputeDetail({ dispute_id: `PP-R-${randomUUID()}`, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE", update_time: "2026-10-21T11:00:00Z", evidences: [{ source: "REQUESTED_FROM_SELLER", evidence_type: "PROOF_OF_FULFILLMENT" }], links: [{ rel: "provide-evidence", method: "POST", href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/example/provide-evidence" }] });
before(async () => {
  pg = await PGlite.create();
  const migration = await readFile("db/migrations/004_evidence_submissions.sql", "utf8");
  await pg.exec(migration);
  await pg.exec(migration);
  db = { query: async <T extends object>(sql: string, values?: unknown[]) => (await pg.query<T>(sql, values)).rows };
});
after(async () => { await pg?.close(); });
function fixture() {
  const current = currentCase();
  const repository = new EvidenceSubmissionRepository(db);
  let writes = 0;
  const deps: EvidenceDependencies = { credentials, repository, now: () => currentTime, client: { getDispute: async () => current, provideEvidence: async () => { writes++; return { debugId: "debug-test" }; } } };
  return { current, repository, deps, writes: () => writes };
}

test("Sandbox placeholders are rejected without invoking a provider", () => {
  assert.throws(() => evidenceCredentials({ PAYPAL_CLIENT_ID: "anyword", PAYPAL_SECRET: "anyword" }), { code: "PAYPAL_NOT_CONFIGURED" });
  assert.deepEqual(evidenceCredentials({ PAYPAL_CLIENT_ID: " test ", PAYPAL_SECRET: " secret " }), { clientId: "test", secret: "secret" });
});

test("the server preview binds the current case and exact material without sending evidence", async () => {
  const { current, deps, writes } = fixture();
  const preview = await previewEvidence(current.id, upload(), deps);
  assert.equal(preview.environment, "sandbox");
  assert.equal(preview.evidences[0].notes, evidenceInput().notes);
  assert.equal(preview.expiresAt, "2026-10-21T12:10:00.000Z");
  assert.equal(readEvidenceReview(preview.reviewToken, current.id, credentials).disputeId, current.id);
  assert.equal(writes(), 0);
});

test("current seller status, action availability, requested type and required references are validated", async () => {
  const current = currentCase();
  validateEvidenceForCase(current, upload());
  assert.throws(() => validateEvidenceForCase({ ...current, status: "UNDER_REVIEW" }, upload()), { code: "EVIDENCE_ACTION_UNAVAILABLE" });
  assert.throws(() => validateEvidenceForCase({ ...current, canProvideEvidence: false }, upload()), { code: "EVIDENCE_ACTION_UNAVAILABLE" });
  assert.throws(() => validateEvidenceForCase({ ...current, requestedEvidence: [] }, upload()), { code: "EVIDENCE_TYPE_NOT_REQUESTED" });
  assert.throws(() => validateEvidenceForCase(current, upload({ type: "OTHER" })), { code: "EVIDENCE_TYPE_NOT_REQUESTED" });
  assert.throws(() => validateEvidenceForCase({ ...current, reason: "UNAUTHORISED" }, upload()), { code: "EVIDENCE_INCOMPLETE" });
  const refund = { ...current, requestedEvidence: ["PROOF_OF_REFUND"] };
  assert.throws(() => validateEvidenceForCase(refund, upload({ type: "PROOF_OF_REFUND" })), { code: "EVIDENCE_INCOMPLETE" });
  validateEvidenceForCase(refund, upload({ type: "PROOF_OF_REFUND", refundReference: "EXISTING-REFUND" }));
  assert.throws(() => validateEvidenceForCase({ ...current, requestedEvidence: ["FUTURE_EVIDENCE"] }, upload({ type: "FUTURE_EVIDENCE" })), { code: "EVIDENCE_INCOMPLETE" });
});

test("multipart preserves actual file bytes and evidence associations with safe unique filenames", async () => {
  const pdf1 = new File(["%PDF-1.7\nfirst proof"], "物流凭证.pdf", { type: "application/pdf" });
  const pdf2 = new File(["%PDF-1.7\nsecond proof"], "物流凭证.pdf", { type: "application/pdf" });
  const data: AssessmentUpload = { inputs: [evidenceInput({ fileKeys: ["file-1", "file-2"], carrier: "Some carrier", trackingNumber: "TRACK-1" })], files: new Map([["file-1", pdf1], ["file-2", pdf2]]) };
  const packet = await packageEvidence(data);
  const outgoing = evidenceMultipart(packet);
  const form = await new Response(outgoing.body, { headers: { "Content-Type": outgoing.contentType } }).formData();
  assert.equal(typeof form.get("input"), "string");
  const body = JSON.parse(form.get("input") as string);
  assert.deepEqual(body.evidences[0].documents, [{ name: "evidence-1.pdf" }, { name: "evidence-2.pdf" }]);
  assert.deepEqual(body.evidences[0].evidence_info.tracking_info, [{ carrier_name: "OTHER", carrier_name_other: "Some carrier", tracking_number: "TRACK-1" }]);
  assert.equal((form.get("file1") as File).name, "evidence-1.pdf");
  assert.equal(await (form.get("file1") as File).text(), await pdf1.text());
  assert.equal(await (form.get("file2") as File).text(), await pdf2.text());
  assert.equal(packet.items[0].documents[0].name, "物流凭证.pdf");
  const repeated = await packageEvidence(data);
  assert.equal(packet.hash, repeated.hash);
});

test("refund references are serialized as proof and malformed/cross-type fields cannot be silently dropped", async () => {
  const packet = await packageEvidence(upload({ type: "PROOF_OF_REFUND", refundReference: "REFUND-1" }));
  assert.deepEqual(packet.payload.evidences[0].evidence_info, { refund_ids: ["REFUND-1"] });
  await assert.rejects(packageEvidence(upload({ carrier: "UPS" })), { code: "INCOMPLETE_TRACKING" });
  await assert.rejects(packageEvidence(upload({ type: "OTHER", carrier: "UPS", trackingNumber: "X" })), { code: "UNEXPECTED_TRACKING" });
  await assert.rejects(packageEvidence(upload({ refundReference: "REFUND-1" })), { code: "UNEXPECTED_REFUND_REFERENCE" });
  await assert.rejects(packageEvidence(upload({ notes: "" })), { code: "NO_EVIDENCE" });
  await assert.rejects(packageEvidence({ inputs: [evidenceInput({ fileKeys: ["file-1"] })], files: new Map([["file-1", new File(["not a PDF"], "fake.pdf")]]) }), { code: "INVALID_EVIDENCE_FILE" });
});

test("review signatures are scoped to the merchant and case, and cannot be forged", async () => {
  const { current, deps } = fixture();
  const preview = await previewEvidence(current.id, upload(), deps);
  assert.throws(() => readEvidenceReview(`${preview.reviewToken}x`, current.id, credentials), { code: "EVIDENCE_REVIEW_REQUIRED" });
  assert.throws(() => readEvidenceReview(preview.reviewToken, "OTHER-CASE", credentials), { code: "EVIDENCE_REVIEW_REQUIRED" });
  assert.throws(() => readEvidenceReview(preview.reviewToken, current.id, { ...credentials, clientId: "other-merchant" }), { code: "EVIDENCE_REVIEW_REQUIRED" });
  assert.throws(() => readEvidenceReview(null, current.id, credentials), { code: "EVIDENCE_REVIEW_REQUIRED" });
});

test("edited evidence, changed cases, stale action availability and expired reviews never reach the write API", async () => {
  const { current, deps, writes } = fixture();
  const preview = await previewEvidence(current.id, upload(), deps);
  await assert.rejects(submitEvidence(current.id, upload({ notes: "Changed" }), preview.reviewToken, deps, signal()), { code: "EVIDENCE_CHANGED" });
  current.updatedAt = "2026-10-21T12:01:00Z";
  await assert.rejects(submitEvidence(current.id, upload(), preview.reviewToken, deps, signal()), { code: "DISPUTE_CHANGED" });
  current.status = "RESOLVED";
  await assert.rejects(submitEvidence(current.id, upload(), preview.reviewToken, deps, signal()), { code: "EVIDENCE_ACTION_UNAVAILABLE" });
  current.status = "WAITING_FOR_SELLER_RESPONSE";
  await assert.rejects(submitEvidence(current.id, upload(), preview.reviewToken, { ...deps, now: () => currentTime + 600001 }, signal()), { code: "EVIDENCE_REVIEW_EXPIRED" });
  assert.equal(writes(), 0);
});

test("duplicate and concurrent confirmations send exactly one POST and replay the stored receipt", async () => {
  const { current, deps, writes } = fixture();
  const preview = await previewEvidence(current.id, upload(), deps);
  const results = await Promise.allSettled([submitEvidence(current.id, upload(), preview.reviewToken, deps, signal()), submitEvidence(current.id, upload(), preview.reviewToken, deps, signal())]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  assert.equal(writes(), 1);
  const receipt = await submitEvidence(current.id, upload(), preview.reviewToken, { ...deps, now: () => currentTime + 3600000 }, signal());
  assert.equal(receipt.status, "submitted");
  assert.equal(receipt.debugId, "debug-test");
  assert.equal(writes(), 1);
  const secondReview = createEvidenceReview(current, await packageEvidence(upload()), credentials, currentTime);
  const duplicate = await submitEvidence(current.id, upload(), secondReview.reviewToken, deps, signal());
  assert.equal(duplicate.submissionId, receipt.submissionId);
  assert.equal(writes(), 1);
});

test("the database permits only one pending request per case even for different evidence/review IDs", async () => {
  const { current, repository } = fixture();
  const packet = await packageEvidence(upload());
  const first = readEvidenceReview(createEvidenceReview(current, packet, credentials, currentTime).reviewToken, current.id, credentials);
  const second = readEvidenceReview(createEvidenceReview(current, await packageEvidence(upload({ notes: "Different package" })), credentials, currentTime).reviewToken, current.id, credentials);
  const reserved = await Promise.all([repository.reserve(first), repository.reserve(second)]);
  assert.equal(reserved.filter((item) => item.acquired).length, 1);
  assert.equal(reserved[0].record.id, reserved[1].record.id);
  const anotherProcess = new EvidenceSubmissionRepository(db);
  assert.ok(await anotherProcess.get(reserved[0].acquired ? first : second));
});

test("unknown network outcomes remain blocked across process/repository instances and do not retry", async () => {
  const { current, deps, repository } = fixture();
  let attempts = 0;
  deps.client.provideEvidence = async () => { attempts++; throw new PayPalEvidenceError("EVIDENCE_OUTCOME_UNKNOWN", "Verify in PayPal", 503, "unknown"); };
  const preview = await previewEvidence(current.id, upload(), deps);
  await assert.rejects(submitEvidence(current.id, upload(), preview.reviewToken, deps, signal()), { code: "EVIDENCE_OUTCOME_UNKNOWN" });
  const review = readEvidenceReview(preview.reviewToken, current.id, credentials);
  assert.equal((await repository.get(review))?.state, "unknown");
  const retryDeps = { ...deps, repository: new EvidenceSubmissionRepository(db) };
  await assert.rejects(submitEvidence(current.id, upload(), preview.reviewToken, retryDeps, signal()), { code: "EVIDENCE_SUBMISSION_RECORDED" });
  const newReview = await previewEvidence(current.id, upload({ notes: "Additional evidence" }), retryDeps);
  await assert.rejects(submitEvidence(current.id, upload({ notes: "Additional evidence" }), newReview.reviewToken, retryDeps, signal()), { code: "EVIDENCE_SUBMISSION_BUSY" });
  assert.equal(attempts, 1);
});

test("definite rejection requires a fresh confirmation and allows a later explicit retry", async () => {
  const { current, deps, repository } = fixture();
  const preview = await previewEvidence(current.id, upload(), deps);
  deps.client.provideEvidence = async () => { throw new PayPalEvidenceError("PAYPAL_EVIDENCE_REJECTED", "Rejected", 422, "rejected"); };
  await assert.rejects(submitEvidence(current.id, upload(), preview.reviewToken, deps, signal()), { code: "PAYPAL_EVIDENCE_REJECTED" });
  assert.equal((await repository.get(readEvidenceReview(preview.reviewToken, current.id, credentials)))?.state, "rejected");
  await assert.rejects(submitEvidence(current.id, upload(), preview.reviewToken, deps, signal()), { code: "EVIDENCE_SUBMISSION_RECORDED" });
  deps.client.provideEvidence = async () => ({ debugId: null });
  const nextPreview = await previewEvidence(current.id, upload(), deps);
  assert.equal((await submitEvidence(current.id, upload(), nextPreview.reviewToken, deps, signal())).status, "submitted");
});

test("an accepted submission stays successful when the follow-up case read fails", async () => {
  const { current, deps, writes } = fixture();
  const preview = await previewEvidence(current.id, upload(), deps);
  let reads = 0;
  deps.client.getDispute = async () => { if (++reads > 1) throw new Error("read unavailable"); return current; };
  const result = await submitEvidence(current.id, upload(), preview.reviewToken, deps, signal());
  assert.equal(result.status, "submitted");
  assert.equal(result.dispute, null);
  assert.match(result.refreshWarning!, /accepted the evidence/);
  assert.equal(writes(), 1);
});

test("failure to save an accepted receipt preserves a blocking operation", async () => {
  const { current, deps, repository, writes } = fixture();
  const preview = await previewEvidence(current.id, upload(), deps);
  const broken = { ...deps, repository: { ready: () => repository.ready(), get: (review: Parameters<typeof repository.get>[0]) => repository.get(review), reserve: (review: Parameters<typeof repository.reserve>[0]) => repository.reserve(review), submitted: async () => { throw new Error("database lost"); }, failed: (...args: Parameters<typeof repository.failed>) => repository.failed(...args) } };
  await assert.rejects(submitEvidence(current.id, upload(), preview.reviewToken, broken, signal()), { code: "EVIDENCE_OUTCOME_UNKNOWN" });
  assert.equal((await repository.get(readEvidenceReview(preview.reviewToken, current.id, credentials)))?.state, "unknown");
  await assert.rejects(submitEvidence(current.id, upload(), preview.reviewToken, deps, signal()), { code: "EVIDENCE_SUBMISSION_RECORDED" });
  assert.equal(writes(), 1);
});

test("cancelling before confirmation reservation prevents a provider mutation", async () => {
  const { current, deps, writes } = fixture();
  const preview = await previewEvidence(current.id, upload(), deps);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(submitEvidence(current.id, upload(), preview.reviewToken, deps, controller.signal), { name: "AbortError" });
  assert.equal(writes(), 0);
});

test("PayPal client posts the exact multipart payload to a fixed Sandbox host without following links", async () => {
  const packet = evidenceMultipart(await packageEvidence(upload()));
  const calls: string[] = [];
  const client = createPayPalDisputesClient(() => credentials, async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("/oauth2/token")) return Response.json({ access_token: "test-token", expires_in: 3600 });
    assert.equal(String(url), "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-TEST/provide-evidence");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token");
    const form = await new Response(init!.body, { headers: { "Content-Type": new Headers(init?.headers).get("Content-Type")! } }).formData();
    assert.equal(JSON.parse(form.get("input") as string).evidences[0].notes, evidenceInput().notes);
    return Response.json({ links: [{ rel: "self", href: "https://untrusted.example" }] }, { headers: { "paypal-debug-id": "safe-debug" } });
  });
  assert.deepEqual(await client.provideEvidence("PP-R-TEST", packet), { debugId: "safe-debug" });
  assert.equal(calls.length, 2);
  await assert.rejects(client.provideEvidence("../escape", packet), { code: "INVALID_DISPUTE_ID" });
  assert.equal(calls.length, 2);
});

test("401/403/422/429 rejections and 5xx/network uncertainty are sanitized and never auto-retried", async () => {
  const packet = evidenceMultipart(await packageEvidence(upload()));
  for (const status of [401, 403, 422, 429, 500]) {
    let writes = 0;
    const client = createPayPalDisputesClient(() => credentials, async (url) => {
      if (String(url).endsWith("/oauth2/token")) return Response.json({ access_token: "token", expires_in: 3600 });
      writes++; return new Response("private payload secret", { status });
    });
    await assert.rejects(client.provideEvidence("PP-R-TEST", packet), (error: unknown) => {
      assert.ok(error instanceof PayPalEvidenceError);
      assert.equal(error.outcome, status === 500 ? "unknown" : "rejected");
      assert.ok(!error.message.includes("private payload")); return true;
    });
    assert.equal(writes, 1);
  }
  let writes = 0;
  const unavailable = createPayPalDisputesClient(() => credentials, async (url) => {
    if (String(url).endsWith("/oauth2/token")) return Response.json({ access_token: "token", expires_in: 3600 });
    writes++; throw new Error("private transport data");
  });
  await assert.rejects(unavailable.provideEvidence("PP-R-TEST", packet), { code: "EVIDENCE_OUTCOME_UNKNOWN", outcome: "unknown" });
  assert.equal(writes, 1);
});
