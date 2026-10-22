import type { DisputeDetail } from "../disputes";
import type { AssessmentUpload } from "../assessment/input";
import { PayPalEvidenceError } from "../paypal-disputes-client";
import type { EvidenceReceipt, EvidenceSubmissionResult } from "../paypal-evidence";
import { createEvidenceReview, evidenceCaseHash, evidenceMultipart, EvidenceSubmissionError, packageEvidence, readEvidenceReview, validateEvidenceForCase, type EvidenceCredentials, type EvidenceReview } from "./package";
import type { EvidenceSubmissionRecord, EvidenceSubmissionRepository } from "./repository";

export type EvidenceDependencies = {
  credentials: EvidenceCredentials;
  client: { getDispute(id: string): Promise<DisputeDetail>; provideEvidence(id: string, packet: ReturnType<typeof evidenceMultipart>): Promise<{ debugId: string | null }> };
  repository: Pick<EvidenceSubmissionRepository, "ready" | "get" | "reserve" | "submitted" | "failed">;
  now?: () => number;
};
export async function previewEvidence(id: string, upload: AssessmentUpload, deps: EvidenceDependencies) {
  await deps.repository.ready();
  const packet = await packageEvidence(upload);
  const dispute = await deps.client.getDispute(id);
  validateEvidenceForCase(dispute, upload);
  return createEvidenceReview(dispute, packet, deps.credentials, (deps.now ?? Date.now)());
}
function previousReceipt(record: EvidenceSubmissionRecord, review: EvidenceReview): EvidenceReceipt {
  if (record.payloadHash !== review.payloadHash || record.caseHash !== review.caseHash) throw new EvidenceSubmissionError("EVIDENCE_SUBMISSION_BUSY", "A previous submission for this case still needs verification. Check the case in PayPal before submitting more evidence.", 409);
  if (record.state === "submitted" && record.receipt) return record.receipt;
  const message = record.state === "rejected" ? "This evidence attempt was rejected. Review the current case and prepare a new confirmation."
    : "A previous evidence submission is pending or its result is uncertain. Check the case in PayPal before submitting again.";
  throw new EvidenceSubmissionError("EVIDENCE_SUBMISSION_RECORDED", message, 409);
}
async function withRefreshedCase(receipt: EvidenceReceipt, deps: EvidenceDependencies): Promise<EvidenceSubmissionResult> {
  try { return { ...receipt, dispute: await deps.client.getDispute(receipt.disputeId), refreshWarning: null }; }
  catch { return { ...receipt, dispute: null, refreshWarning: "PayPal accepted the evidence, but the updated case could not be loaded. Refresh the case; do not submit the same evidence again." }; }
}
export async function submitEvidence(id: string, upload: AssessmentUpload, token: string | null, deps: EvidenceDependencies, signal: AbortSignal): Promise<EvidenceSubmissionResult> {
  const review = readEvidenceReview(token, id, deps.credentials);
  const packet = await packageEvidence(upload);
  if (packet.hash !== review.payloadHash) throw new EvidenceSubmissionError("EVIDENCE_CHANGED", "The evidence has changed since review. Open a new confirmation before submitting.", 409);
  const existing = await deps.repository.get(review);
  // Replaying an accepted confirmation returns its receipt even if the case has
  // moved on or the confirmation expired. It never sends another evidence POST.
  if (existing) return withRefreshedCase(previousReceipt(existing, review), deps);
  const now = (deps.now ?? Date.now)();
  if (review.expiresAt <= now) throw new EvidenceSubmissionError("EVIDENCE_REVIEW_EXPIRED", "The confirmation expired. Review the latest case and evidence again.", 409);
  const dispute = await deps.client.getDispute(id);
  validateEvidenceForCase(dispute, upload);
  if (review.caseHash !== evidenceCaseHash(dispute)) throw new EvidenceSubmissionError("DISPUTE_CHANGED", "The PayPal case changed since review. Refresh it and review the evidence again.", 409);
  signal.throwIfAborted();
  const reservation = await deps.repository.reserve(review);
  if (!reservation.acquired) return withRefreshedCase(previousReceipt(reservation.record, review), deps);
  // After reserving the operation, finish recording the outcome even if the
  // browser disconnects. Ambiguous network outcomes are never retried.
  let accepted: { debugId: string | null };
  try { accepted = await deps.client.provideEvidence(id, evidenceMultipart(packet)); }
  catch (error) {
    const rejected = error instanceof PayPalEvidenceError && error.outcome === "rejected";
    const code = error instanceof PayPalEvidenceError ? error.code : "EVIDENCE_OUTCOME_UNKNOWN";
    try { await deps.repository.failed(review, rejected ? "rejected" : "unknown", code); } catch { /* A retained pending row also prevents retries. */ }
    if (error instanceof PayPalEvidenceError) throw error;
    throw new EvidenceSubmissionError("EVIDENCE_OUTCOME_UNKNOWN", "The submission result is uncertain. Verify the case in PayPal before submitting again.", 503);
  }
  const receipt: EvidenceReceipt = { submissionId: review.id, disputeId: id, status: "submitted", environment: "sandbox", submittedAt: new Date((deps.now ?? Date.now)()).toISOString(), debugId: accepted.debugId };
  try { await deps.repository.submitted(review, receipt); }
  catch {
    try { await deps.repository.failed(review, "unknown", "EVIDENCE_RECEIPT_NOT_SAVED"); } catch { /* Do not resend an accepted request. */ }
    throw new EvidenceSubmissionError("EVIDENCE_OUTCOME_UNKNOWN", "PayPal accepted the evidence, but its receipt could not be saved. Verify the case in PayPal before any further submission.", 503);
  }
  return withRefreshedCase(receipt, deps);
}
