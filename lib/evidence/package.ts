import { createHash, randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import type { DisputeDetail } from "../disputes";
import { assessEvidence, evidenceTitle, getEvidencePlan, type EvidenceInput } from "../dispute-evidence";
import { readEvidenceBytes, type AssessmentUpload } from "../assessment/input";
import type { EvidencePreviewItem, EvidenceSubmissionPreview, PayPalEvidence } from "../paypal-evidence";

export class EvidenceSubmissionError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = "EvidenceSubmissionError"; }
}
export type EvidenceCredentials = { clientId: string; secret: string };
export function evidenceCredentials(env: Record<string, string | undefined> = process.env): EvidenceCredentials {
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const secret = env.PAYPAL_SECRET?.trim();
  if (!clientId || !secret || clientId === "anyword" || secret === "anyword") throw new EvidenceSubmissionError("PAYPAL_NOT_CONFIGURED", "Set PayPal Sandbox credentials in .env.local before submitting evidence.", 503);
  return { clientId, secret };
}
export const merchantScope = (credentials: EvidenceCredentials) => createHash("sha256").update(credentials.clientId).digest("hex");
export const evidenceCaseHash = (dispute: DisputeDetail) => createHash("sha256").update(JSON.stringify({ ...dispute, raw: undefined })).digest("hex");
export type EvidencePackage = {
  payload: { evidences: PayPalEvidence[] }; items: EvidencePreviewItem[]; hash: string;
  files: { part: string; name: string; mime: string; bytes: Buffer }[];
};

export async function packageEvidence(upload: AssessmentUpload): Promise<EvidencePackage> {
  const payload: EvidencePackage["payload"] = { evidences: [] };
  const items: EvidencePreviewItem[] = [];
  const files: EvidencePackage["files"] = [];
  const hashes: string[] = [];
  for (const input of [...upload.inputs].sort((a, b) => a.type.localeCompare(b.type))) {
    if (!input.notes && !input.carrier && !input.trackingNumber && !input.refundReference && !input.fileKeys.length) continue;
    const evidence: PayPalEvidence = { evidence_type: input.type };
    if (input.notes) evidence.notes = input.notes;
    if (!!input.carrier !== !!input.trackingNumber) throw new EvidenceSubmissionError("INCOMPLETE_TRACKING", "Provide both the carrier and tracking number, or clear both fields.");
    if (input.type !== "PROOF_OF_FULFILLMENT" && (input.carrier || input.trackingNumber)) throw new EvidenceSubmissionError("UNEXPECTED_TRACKING", "Tracking information must belong to fulfillment evidence.");
    if (input.type !== "PROOF_OF_REFUND" && input.refundReference) throw new EvidenceSubmissionError("UNEXPECTED_REFUND_REFERENCE", "Refund references must belong to refund evidence.");
    if (input.carrier && input.trackingNumber) evidence.evidence_info = { tracking_info: [{ carrier_name: "OTHER", carrier_name_other: input.carrier, tracking_number: input.trackingNumber }] };
    if (input.refundReference) evidence.evidence_info = { refund_ids: [input.refundReference] };
    const documents: EvidencePreviewItem["documents"] = [];
    for (const key of input.fileKeys) {
      const file = upload.files.get(key);
      if (!file) throw new EvidenceSubmissionError("MISSING_ATTACHMENT", "An evidence file is missing. Add it again before submitting.");
      const { bytes, mime } = await readEvidenceBytes(file);
      const index = files.length + 1;
      // PayPal's document name schema allows ASCII names. Keep a visible mapping
      // for Unicode/duplicate filenames and bind each evidence to its exact upload.
      const name = `evidence-${index}.${file.name.split(".").pop()!.toLowerCase()}`;
      files.push({ part: `file${index}`, name, mime, bytes });
      hashes.push(createHash("sha256").update(bytes).digest("hex"));
      documents.push({ name: file.name, uploadName: name, size: bytes.length });
    }
    if (documents.length) evidence.documents = documents.map((document) => ({ name: document.uploadName }));
    payload.evidences.push(evidence);
    items.push({ type: input.type, title: evidenceTitle(input.type), notes: input.notes, carrier: input.carrier, trackingNumber: input.trackingNumber, refundReference: input.refundReference, documents });
  }
  if (!payload.evidences.length) throw new EvidenceSubmissionError("NO_EVIDENCE", "Prepare at least one evidence note, reference or file.");
  const hash = createHash("sha256").update(JSON.stringify({ payload, hashes, items })).digest("hex");
  return { payload, items, hash, files };
}

export function validateEvidenceForCase(dispute: DisputeDetail, upload: AssessmentUpload) {
  if (dispute.status !== "WAITING_FOR_SELLER_RESPONSE" || !dispute.canProvideEvidence) throw new EvidenceSubmissionError("EVIDENCE_ACTION_UNAVAILABLE", "PayPal is not currently accepting seller evidence for this case. Refresh the case before continuing.", 409);
  const plan = getEvidencePlan(dispute);
  const inputs: Record<string, EvidenceInput> = {};
  for (const input of upload.inputs) {
    const supplied = input.notes || input.carrier || input.trackingNumber || input.refundReference || input.fileKeys.length;
    if (supplied && !dispute.requestedEvidence.includes(input.type)) throw new EvidenceSubmissionError("EVIDENCE_TYPE_NOT_REQUESTED", `${evidenceTitle(input.type)} is not in the current seller evidence request. Refresh and review the requested types.`, 409);
    inputs[input.type] = { ...input, files: input.fileKeys.map((key) => upload.files.get(key)!) };
  }
  const check = assessEvidence(plan, inputs, true);
  if (!check.canPreviewSubmission) throw new EvidenceSubmissionError("EVIDENCE_INCOMPLETE", [check.suggestion, ...check.checks.flatMap((item) => item.missing)].join(" "));
}

export function evidenceMultipart(packet: EvidencePackage) {
  const boundary = `deflect-${randomUUID()}`;
  // A JSON part without a filename matches PayPal's input=...;type=application/json
  // contract. Native FormData would add filename="blob" for a JSON Blob.
  const parts: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="input"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(packet.payload)}\r\n`)];
  for (const file of packet.files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.part}"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`), file.bytes, Buffer.from("\r\n"));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: new Uint8Array(Buffer.concat(parts)), contentType: `multipart/form-data; boundary=${boundary}` };
}

export type EvidenceReview = { version: 1; id: string; disputeId: string; scope: string; caseHash: string; payloadHash: string; expiresAt: number };
function signature(value: string, credentials: EvidenceCredentials) { return createHmac("sha256", credentials.secret).update(`deflect:sandbox:evidence-review:v1:${credentials.clientId}:${value}`).digest(); }
export function createEvidenceReview(dispute: DisputeDetail, packet: EvidencePackage, credentials: EvidenceCredentials, now = Date.now()): EvidenceSubmissionPreview {
  const review: EvidenceReview = { version: 1, id: randomUUID(), disputeId: dispute.id, scope: merchantScope(credentials), caseHash: evidenceCaseHash(dispute), payloadHash: packet.hash, expiresAt: now + 10 * 60 * 1000 };
  const body = Buffer.from(JSON.stringify(review)).toString("base64url");
  return { reviewToken: `${body}.${signature(body, credentials).toString("base64url")}`, expiresAt: new Date(review.expiresAt).toISOString(), disputeId: dispute.id, caseUpdatedAt: dispute.updatedAt, environment: "sandbox", evidences: packet.items };
}
export function readEvidenceReview(token: string | null, id: string, credentials: EvidenceCredentials): EvidenceReview {
  try {
    if (!token || token.length > 4096) throw new Error();
    const [body, encoded, extra] = token.split(".");
    const expected = signature(body, credentials);
    const actual = Buffer.from(encoded, "base64url");
    if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const review = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as EvidenceReview;
    if (review.version !== 1 || review.disputeId !== id || review.scope !== merchantScope(credentials) || !/^[0-9a-f-]{36}$/.test(review.id)
        || !/^[a-f0-9]{64}$/.test(review.caseHash) || !/^[a-f0-9]{64}$/.test(review.payloadHash) || !Number.isSafeInteger(review.expiresAt)) throw new Error();
    return review;
  } catch { throw new EvidenceSubmissionError("EVIDENCE_REVIEW_REQUIRED", "Review the evidence in the confirmation dialog before submitting.", 409); }
}
