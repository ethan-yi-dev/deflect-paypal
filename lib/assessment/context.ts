import { createHash } from "node:crypto";
import type { DisputeDetail } from "../disputes";
import type { SearchHit } from "../knowledge/types";
import { readEvidenceBytes, type AssessmentUpload, type MerchantEvidenceInput } from "./input";
import { AssessmentError } from "./config";
import { ASSESSMENT_ACTIONS, type AssessmentAction, type AssessmentSource } from "./types";

export type ModelContent = { type: "input_text"; text: string } | { type: "input_file"; filename: string; file_data: string } | { type: "input_image"; image_url: string; detail: "auto" };
export type AssessmentContext = { sources: AssessmentSource[]; attachments: ModelContent[]; snapshotHash: string; allowedActions: AssessmentAction[] };

export function allowedAssessmentActions(dispute: DisputeDetail): AssessmentAction[] {
  const available = new Set(dispute.availableActions.map((action) => action.toLowerCase().replaceAll("-", "_")));
  if (!dispute.canProvideEvidence) available.delete("provide_evidence");
  return ASSESSMENT_ACTIONS.filter((action) => action === "gather_evidence" || action === "manual_review" || available.has(action));
}

export function buildRetrievalQuery(dispute: DisputeDetail, inputs: MerchantEvidenceInput[]): string {
  // Bound individual fields so a long complaint cannot crowd out the search topics.
  const buyerClaim = dispute.messages.filter((message) => message.author === "BUYER").map((message) => message.content.slice(0, 220)).join(" ").slice(0, 500);
  const notes = inputs.map((input) => `${input.type}: ${input.notes.slice(0, 150)}${input.carrier || input.trackingNumber ? "; merchant supplied tracking (delivery not verified)" : ""}${input.refundReference ? "; merchant supplied refund reference (not verified)" : ""}`).join(" ").slice(0, 700);
  return [
    `Dispute reason: ${dispute.reason ?? "unknown"}. Stage: ${dispute.stage ?? "unknown"}.`,
    `Buyer claim (statement, not verified): ${buyerClaim || "not provided"}`,
    `Requested seller evidence: ${dispute.requestedEvidence.join(", ") || "not specified"}.`,
    `Merchant evidence: ${notes || "not supplied"}. Case tracking records: ${dispute.tracking.length}; attached files: ${inputs.reduce((sum, input) => sum + input.fileKeys.length, 0)}.`,
    "Find applicable PayPal dispute evidence requirements and merchant shipping, return, refund or billing policies. Identify required proof and policy limitations.",
  ].join("\n").slice(0, 2000);
}

export async function buildAssessmentContext(dispute: DisputeDetail, upload: AssessmentUpload, hits: SearchHit[]): Promise<AssessmentContext> {
  const sources: AssessmentSource[] = [];
  const attachments: ModelContent[] = [];
  const fileHashes: string[] = [];
  function add(id: string, title: string, content: unknown, authority: AssessmentSource["authority"] = "paypal_record", kind: AssessmentSource["kind"] = "case") {
    sources.push({ id, title, kind, authority, content: typeof content === "string" ? content : JSON.stringify(content), pageNumber: null, documentId: null, chunkId: null });
  }
  add("C-case", "PayPal case details", { id: dispute.id, reason: dispute.reason, status: dispute.status, stage: dispute.stage, state: dispute.state, channel: dispute.channel, initiatedBy: dispute.initiatedBy, createdAt: dispute.createdAt, updatedAt: dispute.updatedAt, sellerResponseDueAt: dispute.sellerResponseDueAt });
  add("C-amounts", "Dispute and refund amounts", { amount: dispute.amount, buyerRequestedAmount: dispute.buyerRequestedAmount, allowedRefundAmount: dispute.allowedRefundAmount });
  add("C-actions", "Current PayPal response options", { requestedEvidence: dispute.requestedEvidence, canProvideEvidence: dispute.canProvideEvidence, availableActions: dispute.availableActions, allowedResponseOptions: dispute.allowedResponseOptions });
  dispute.transactions.forEach((transaction, index) => add(`C-transaction-${index + 1}`, `PayPal transaction ${index + 1}`, transaction));
  dispute.messages.forEach((message, index) => add(`C-message-${index + 1}`, `${message.author} message ${index + 1}`, message, message.author === "BUYER" ? "buyer_statement" : message.author === "SELLER" ? "merchant_statement" : message.author === "PAYPAL" ? "paypal_record" : "unattributed_statement"));
  dispute.tracking.forEach((tracking, index) => add(`C-tracking-${index + 1}`, `Tracking recorded in case ${index + 1}`, { ...tracking, limitation: "A recorded tracking reference is not carrier verification or proof of delivery." }));
  dispute.fundMovements.forEach((movement, index) => add(`C-funds-${index + 1}`, `PayPal fund movement ${index + 1}`, movement));
  dispute.sellerDocuments.forEach((document, index) => add(`C-document-${index + 1}`, `Previously submitted document: ${document.name}`, { ...document, limitation: "Metadata only. The document contents are not available in this case response." }));
  for (const [index, input] of upload.inputs.entries()) {
    if (input.notes || input.carrier || input.trackingNumber || input.refundReference) add(`M-${index + 1}`, `Merchant input: ${input.type}`, { type: input.type, notes: input.notes, carrier: input.carrier, trackingNumber: input.trackingNumber, refundReference: input.refundReference }, "merchant_statement", "merchant_input");
    for (const key of input.fileKeys) {
      const file = upload.files.get(key)!;
      const { bytes, mime } = await readEvidenceBytes(file);
      const id = `E-${key.slice(5)}`;
      fileHashes.push(`${id}:${createHash("sha256").update(bytes).digest("hex")}`);
      add(id, file.name, { evidenceType: input.type, filename: file.name, size: file.size, limitation: "Merchant-uploaded material; inspect the attached contents, attribute claims, and report unreadable or missing details." }, "uploaded_evidence", "evidence");
      attachments.push({ type: "input_text", text: `The following attachment belongs to source ${id}: ${JSON.stringify(file.name)}. Cite this source ID for observations from the attachment. Mention PDF page numbers in your explanation when visible.` });
      const data = `data:${mime};base64,${bytes.toString("base64")}`;
      attachments.push(mime === "application/pdf" ? { type: "input_file", filename: file.name, file_data: data } : { type: "input_image", image_url: data, detail: "auto" });
    }
  }
  hits.forEach((hit, index) => sources.push({ id: `P-${index + 1}`, kind: "policy", authority: "unclassified_policy", title: hit.documentName, content: hit.content, pageNumber: hit.pageNumber, documentId: hit.docId, chunkId: hit.id }));
  // Never silently truncate case records or drop an uploaded attachment.
  if (JSON.stringify(sources).length > 160000) throw new AssessmentError("CASE_CONTEXT_TOO_LARGE", "This case has too much text for one assessment. Reduce the notes or review the case manually.", 413);
  const allowedActions = allowedAssessmentActions(dispute);
  const snapshotHash = createHash("sha256").update(JSON.stringify({ sources, fileHashes, allowedActions })).digest("hex");
  return { sources, attachments, snapshotHash, allowedActions };
}
