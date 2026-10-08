import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDisputeDetail } from "../lib/disputes";
import { createPayPalDisputesClient, PayPalDisputesError } from "../lib/paypal-disputes-client";
import { assessEvidence, checkEvidence, getEvidencePlan, MAX_FILE_BYTES, MAX_TOTAL_BYTES, validateEvidenceFiles, type EvidenceInput } from "../lib/dispute-evidence";

const caseId = "PP-R-TEST-001";
const credentials = () => ({ clientId: "test-client", secret: "test-secret" });
const token = () => Response.json({ access_token: "test-access-token", expires_in: 3600 });
const detail = () => Response.json({ dispute_id: caseId, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" });

test("missing fields remain unknown, with no fabricated payment or fulfillment facts", () => {
  const result = normalizeDisputeDetail({ dispute_id: caseId });
  assert.equal(result.amount, null);
  assert.equal(result.initiatedBy, null);
  assert.equal(result.canProvideEvidence, false);
  assert.deepEqual(result.sellerDocuments, []);
  assert.equal(result.allowedRefundAmount, null);
  assert.equal(result.sellerResponseDueAt, null);
  assert.deepEqual(result.transactions, []);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.tracking, []);
  assert.deepEqual(result.availableActions, []);
});

test("normalization preserves multiple transactions and exact money while deduplicating repeated creation evidence", () => {
  const result = normalizeDisputeDetail({
    dispute_id: caseId,
    dispute_amount: { currency_code: "USD", value: "12345678901234567890.10" },
    disputed_transactions: [{ seller_transaction_id: "CAPTURE-1", buyer_transaction_id: "BUYER-1" }, { seller_transaction_id: "CAPTURE-2" }],
    messages: [{ posted_by: "BUYER", content: "Where is my item?", time_posted: "2026-10-08T05:24:00Z" }],
    evidences: [
      { evidence_type: "CREATE", source: "SUBMITTED_BY_BUYER", notes: "Where is my item?" },
      { evidence_type: "PROOF_OF_FULFILLMENT", source: "REQUESTED_FROM_SELLER" },
      { evidence_type: "OTHER", source: "REQUESTED_FROM_BUYER" },
      { evidence_type: "PROOF_OF_FULFILLMENT", source: "SUBMITTED_BY_SELLER", evidence_info: { tracking_info: [{ carrier_name: "UPS", tracking_number: "TRACK-1" }, { carrier_name: "UPS", tracking_number: "TRACK-1" }] } },
    ],
    links: [{ rel: "self", method: "GET" }, { rel: "send_message", method: "POST" }],
  });
  assert.equal(result.amount?.value, "12345678901234567890.10");
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].sellerTransactionId, "CAPTURE-1");
  assert.equal(result.transactions[0].buyerTransactionId, "BUYER-1");
  assert.equal(result.messages.length, 1);
  assert.equal(result.initiatedBy, "BUYER");
  assert.deepEqual(result.requestedEvidence, ["PROOF_OF_FULFILLMENT"]);
  assert.equal(result.tracking.length, 1);
  assert.deepEqual(result.availableActions, ["send_message"]);
});

test("a missing messages array can use buyer CREATE notes without treating them as verified facts", () => {
  const result = normalizeDisputeDetail({ dispute_id: caseId, evidences: [{ evidence_type: "CREATE", source: "SUBMITTED_BY_BUYER", notes: "Please refund." }] });
  assert.deepEqual(result.messages.map((message) => [message.author, message.content]), [["BUYER", "Please refund."]]);
  assert.equal(result.allowedRefundAmount, null);
});

test("case initiator comes from creation evidence, not from a later message author", () => {
  const sellerCase = normalizeDisputeDetail({
    dispute_id: caseId,
    evidences: [{ evidence_type: "CREATE", source: "SUBMITTED_BY_SELLER" }],
    messages: [{ posted_by: "BUYER", content: "A later reply." }],
  });
  assert.equal(sellerCase.initiatedBy, "SELLER");
  assert.equal(normalizeDisputeDetail({ dispute_id: caseId, messages: [{ posted_by: "BUYER", content: "A reply without creation evidence." }] }).initiatedBy, null);
});

test("evidence preparation uses only seller requests and recognizes a POST evidence link", () => {
  for (const rel of ["provide_evidence", "provide-evidence"]) {
    const result = normalizeDisputeDetail({
      dispute_id: caseId,
      links: [{ rel, method: "POST", href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-TEST-001/provide-evidence" }],
      evidences: [
        { source: "REQUESTED_FROM_BUYER", evidence_type: "PROOF_OF_REFUND" },
        { source: "REQUESTED_FROM_SELLER", evidence_type: "OTHER" },
        { source: "SUBMITTED_BY_BUYER", evidence_type: "OTHER", documents: [{ name: "buyer.pdf" }] },
        { source: "SUBMITTED_BY_SELLER", evidence_type: "OTHER", documents: [{ name: "seller.pdf" }], date: "2026-10-08T00:00:00Z" },
      ],
    });
    assert.equal(result.canProvideEvidence, true);
    assert.deepEqual(result.requestedEvidence, ["OTHER"]);
    assert.deepEqual(result.sellerDocuments, [{ name: "seller.pdf", evidenceType: "OTHER", submittedAt: "2026-10-08T00:00:00Z" }]);
  }
  for (const link of [{ rel: "provide_evidence", method: "GET", href: "https://example.com" }, { rel: "appeal", method: "POST", href: "https://example.com" }, { rel: "provide_evidence", method: "POST" }]) {
    assert.equal(normalizeDisputeDetail({ dispute_id: caseId, links: [link] }).canProvideEvidence, false);
  }
});

const blankEvidence: EvidenceInput = { notes: "", carrier: "", trackingNumber: "", refundReference: "", files: [] };
const pdfEvidence = { name: "delivery.pdf", size: 1000, type: "application/pdf" };

test("all nine baseline reasons are supported without treating reference options as seller requests", () => {
  for (const reason of ["MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", "UNAUTHORISED", "CREDIT_NOT_PROCESSED", "DUPLICATE_TRANSACTION", "INCORRECT_AMOUNT", "PAYMENT_BY_OTHER_MEANS", "CANCELED_RECURRING_BILLING", "OTHER"]) {
    const plan = getEvidencePlan({ reason, requestedEvidence: [] });
    assert.ok(plan.baselineTypes.length >= 2);
    assert.equal(plan.hasSellerRequest, false);
    assert.ok(plan.rules.every((item) => !item.requested));
  }
  const plan = getEvidencePlan({ reason: "DUPLICATE_TRANSACTION", requestedEvidence: [] });
  const assessment = assessEvidence(plan, { OTHER: { ...blankEvidence, notes: "The two invoices describe separate purchases." } }, true);
  assert.equal(assessment.checks.length, 1);
  assert.equal(assessment.checks[0].prepared, true);
  assert.equal(assessment.canPreviewSubmission, false);
});

test("the actual seller evidence request overrides the reason's baseline options", () => {
  const plan = getEvidencePlan({ reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", requestedEvidence: ["OTHER", "OTHER"] });
  assert.deepEqual(plan.rules.map((item) => item.type), ["OTHER"]);
  assert.ok(plan.hasSellerRequest);
  const assessment = assessEvidence(plan, { OTHER: { ...blankEvidence, notes: "The item is available for collection." } }, true);
  assert.equal(assessment.canPreviewSubmission, true);
  assert.equal(assessEvidence(plan, { OTHER: { ...blankEvidence, files: [pdfEvidence] } }, false).canPreviewSubmission, false);
});

test("fulfillment evidence accepts alternatives for INR but requires tracking for unauthorized cases", () => {
  const inrRule = getEvidencePlan({ reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", requestedEvidence: ["PROOF_OF_FULFILLMENT"] }).rules[0];
  const unauthorizedRule = getEvidencePlan({ reason: "UNAUTHORISED", requestedEvidence: ["PROOF_OF_FULFILLMENT"] }).rules[0];
  assert.equal(checkEvidence(inrRule, blankEvidence).prepared, false);
  assert.equal(checkEvidence(inrRule, { ...blankEvidence, files: [pdfEvidence] }).prepared, true);
  assert.equal(checkEvidence(inrRule, { ...blankEvidence, notes: "Customer collected the parcel; receipt attached separately." }).prepared, true);
  assert.equal(checkEvidence(unauthorizedRule, { ...blankEvidence, files: [pdfEvidence] }).prepared, false);
  assert.equal(checkEvidence(unauthorizedRule, { ...blankEvidence, carrier: "FedEx" }).prepared, false);
  assert.equal(checkEvidence(unauthorizedRule, { ...blankEvidence, carrier: "FedEx", trackingNumber: "123456" }).prepared, true);
});

test("refund proof requires an existing refund reference and unknown evidence stays manual", () => {
  const rule = getEvidencePlan({ reason: "CREDIT_NOT_PROCESSED", requestedEvidence: ["PROOF_OF_REFUND"] }).rules[0];
  assert.equal(checkEvidence(rule, { ...blankEvidence, files: [pdfEvidence] }).prepared, false);
  assert.equal(checkEvidence(rule, { ...blankEvidence, refundReference: "PAYPAL-REFUND" }).prepared, true);
  const unknown = getEvidencePlan({ reason: "FUTURE_REASON", requestedEvidence: ["FUTURE_EVIDENCE"] }).rules[0];
  assert.equal(checkEvidence(unknown, { ...blankEvidence, files: [pdfEvidence], notes: "Evidence." }).prepared, false);
  assert.equal(checkEvidence(getEvidencePlan({ reason: "FUTURE_REASON", requestedEvidence: ["OTHER"] }).rules[0], { ...blankEvidence, notes: "Evidence." }).prepared, false);
  assert.equal(checkEvidence(rule, { ...blankEvidence, refundReference: "PAYPAL-REFUND", notes: "a".repeat(2001) }).prepared, false);
});

test("file preparation checks official formats, strict individual limits, and the total across evidence categories", () => {
  assert.equal(validateEvidenceFiles([], [pdfEvidence, { ...pdfEvidence, name: "DELIVERY.PNG", type: "image/png" }]).accepted.length, 2);
  for (const file of [{ ...pdfEvidence, name: "evidence.exe" }, { ...pdfEvidence, type: "text/plain" }, { ...pdfEvidence, size: 0 }, { ...pdfEvidence, size: MAX_FILE_BYTES }]) {
    assert.equal(validateEvidenceFiles([], [file]).accepted.length, 0);
  }
  assert.equal(validateEvidenceFiles([], [{ ...pdfEvidence, size: MAX_FILE_BYTES - 1 }]).accepted.length, 1);
  const existing = [{ ...pdfEvidence, size: MAX_TOTAL_BYTES - 1000 }];
  assert.equal(validateEvidenceFiles(existing, [pdfEvidence]).accepted.length, 1);
  assert.equal(validateEvidenceFiles(existing, [{ ...pdfEvidence, size: 1001 }]).accepted.length, 0);
});

test("concurrent list/detail reads share OAuth and perform only read-only dispute requests", async () => {
  let tokenCalls = 0;
  const calls: { url: string; method: string }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    assert.equal(init?.cache, "no-store");
    if (url.endsWith("/oauth2/token")) {
      tokenCalls++;
      assert.equal(new Headers(init?.headers).get("Authorization"), `Basic ${Buffer.from("test-client:test-secret").toString("base64")}`);
      assert.equal(init?.body, "grant_type=client_credentials");
      return token();
    }
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-access-token");
    return url.endsWith("/disputes") ? Response.json({ items: [{ dispute_id: caseId }] }) : detail();
  };
  const client = createPayPalDisputesClient(credentials, request);
  const [items, dispute] = await Promise.all([client.listDisputes(), client.getDispute(caseId)]);
  await client.getDispute(caseId);
  assert.equal(tokenCalls, 1);
  assert.equal(items[0].id, caseId);
  assert.equal(dispute.id, caseId);
  assert.ok(calls.every((call) => call.url.startsWith("https://api-m.sandbox.paypal.com/")));
  assert.ok(calls.filter((call) => call.url.includes("/customer/disputes")).every((call) => call.method === "GET"));
});

test("an expired/rejected token is refreshed once before retrying the GET", async () => {
  let tokenCalls = 0;
  let detailCalls = 0;
  const client = createPayPalDisputesClient(credentials, async (input) => {
    if (String(input).endsWith("/oauth2/token")) { tokenCalls++; return token(); }
    detailCalls++;
    return detailCalls === 1 ? new Response(null, { status: 401 }) : detail();
  });
  assert.equal((await client.getDispute(caseId)).id, caseId);
  assert.equal(tokenCalls, 2);
  assert.equal(detailCalls, 2);
});

test("repeated authentication failure stops after one refresh", async () => {
  let detailCalls = 0;
  const client = createPayPalDisputesClient(credentials, async (input) => {
    if (String(input).endsWith("/oauth2/token")) return token();
    detailCalls++;
    return new Response(null, { status: 401 });
  });
  await assert.rejects(client.getDispute(caseId), (error: unknown) => error instanceof PayPalDisputesError && error.code === "PAYPAL_AUTH_FAILED");
  assert.equal(detailCalls, 2);
});

for (const [status, code] of [[403, "PAYPAL_ACCESS_DENIED"], [404, "DISPUTE_NOT_FOUND"], [429, "PAYPAL_RATE_LIMITED"]] as const) {
  test(`provider ${status} gets a useful, sanitized error`, async () => {
    const client = createPayPalDisputesClient(credentials, async (input) => String(input).endsWith("/oauth2/token") ? token() : Response.json({ message: "sensitive-upstream-body" }, { status, headers: { "paypal-debug-id": "debug-reference" } }));
    await assert.rejects(client.getDispute(caseId), (error: unknown) => {
      assert.ok(error instanceof PayPalDisputesError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.debugId, "debug-reference");
      assert.ok(!error.message.includes("sensitive-upstream-body"));
      return true;
    });
  });
}

test("invalid IDs cannot make authenticated requests or alter the provider path", async () => {
  let requests = 0;
  const client = createPayPalDisputesClient(credentials, async () => { requests++; return token(); });
  for (const id of ["", "../oauth2/token", "https://example.com", "a?x=1", "a".repeat(256)]) {
    await assert.rejects(client.getDispute(id), (error: unknown) => error instanceof PayPalDisputesError && error.status === 400);
  }
  assert.equal(requests, 0);
});

test("missing credentials produce a configuration error without network traffic", async () => {
  let requests = 0;
  const client = createPayPalDisputesClient(() => ({}), async () => { requests++; return token(); });
  await assert.rejects(client.listDisputes(), (error: unknown) => error instanceof PayPalDisputesError && error.code === "PAYPAL_NOT_CONFIGURED");
  assert.equal(requests, 0);
});

test("provider ID mismatch and malformed JSON cannot become displayed case data", async () => {
  for (const payload of [() => Response.json({ dispute_id: "ANOTHER-CASE" }), () => new Response("not-json")]) {
    const client = createPayPalDisputesClient(credentials, async (input) => String(input).endsWith("/oauth2/token") ? token() : payload());
    await assert.rejects(client.getDispute(caseId), (error: unknown) => error instanceof PayPalDisputesError && error.code === "PAYPAL_INVALID_RESPONSE");
  }
});

test("timeouts and network exceptions hide raw transport details", async () => {
  for (const [failure, code, status] of [[new DOMException("raw-timeout", "TimeoutError"), "PAYPAL_TIMEOUT", 504], [new Error("raw-credentials-in-network-error"), "PAYPAL_UNAVAILABLE", 502]] as const) {
    const client = createPayPalDisputesClient(credentials, async () => { throw failure; });
    await assert.rejects(client.listDisputes(), (error: unknown) => {
      assert.ok(error instanceof PayPalDisputesError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.ok(!error.message.includes("raw-"));
      return true;
    });
  }
});
