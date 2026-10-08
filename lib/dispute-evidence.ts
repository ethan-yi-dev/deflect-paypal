import type { DisputeDetail } from "./disputes";

// Reviewed against PayPal's reason/evidence guide on 2026-10-08.
// This baseline describes possible evidence. Seller requests take precedence.
export const EVIDENCE_GUIDE_URL = "https://developer.paypal.com/platforms/disputes/reference/dispute-reasons/";
export const FILE_GUIDE_URL = "https://developer.paypal.com/platforms/disputes/reference/supported-file-types-sizes/";
export const MAX_FILE_BYTES = 10_000_000; // Each file must be strictly smaller.
export const MAX_TOTAL_BYTES = 50_000_000;
export const EVIDENCE_FILE_ACCEPT = ".jpg,.jpeg,.gif,.png,.pdf";

type Baseline = { title: string; context: string; types: string[] };
const baseline: Record<string, Baseline> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: { title: "Item not received", context: "Prepare shipment or delivery evidence. Refund proof applies if a refund was issued.", types: ["PROOF_OF_FULFILLMENT", "PROOF_OF_REFUND"] },
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: { title: "Item not as described", context: "Collect the listing, item details, return terms, or agreement.", types: ["OTHER", "PROOF_OF_REFUND"] },
  UNAUTHORISED: { title: "Unauthorized purchase", context: "Collect shipment records and relevant delivery documents.", types: ["PROOF_OF_FULFILLMENT", "PROOF_OF_REFUND", "OTHER"] },
  CREDIT_NOT_PROCESSED: { title: "Refund not received", context: "Check the refund reference and explain the outstanding credit.", types: ["PROOF_OF_REFUND", "OTHER"] },
  DUPLICATE_TRANSACTION: { title: "Duplicate charge", context: "Prepare records explaining the duplicate charge or refund.", types: ["PROOF_OF_REFUND", "OTHER"] },
  INCORRECT_AMOUNT: { title: "Incorrect charge amount", context: "Explain the price difference and any refund of that difference.", types: ["PROOF_OF_REFUND", "OTHER"] },
  PAYMENT_BY_OTHER_MEANS: { title: "Paid another way", context: "Collect the alternative payment record and relevant refund details.", types: ["PROOF_OF_REFUND", "OTHER"] },
  CANCELED_RECURRING_BILLING: { title: "Charged after cancellation", context: "Review the subscription agreement, cancellation, and any refund.", types: ["PROOF_OF_REFUND", "OTHER"] },
  OTHER: { title: "Other concern", context: "Explain the case with relevant documents or refund proof.", types: ["PROOF_OF_REFUND", "OTHER"] },
};

export type EvidenceRoute = "tracking-or-document" | "tracking" | "refund" | "notes-or-document" | "manual";
export type EvidenceRule = { type: string; title: string; hint: string; route: EvidenceRoute; requested: boolean };
export type EvidencePlan = { title: string; context: string; rules: EvidenceRule[]; hasSellerRequest: boolean; baselineTypes: string[] };
export type EvidenceFile = { name: string; size: number; type: string };
export type EvidenceInput = { notes: string; carrier: string; trackingNumber: string; refundReference: string; files: EvidenceFile[] };
export type EvidenceCheck = { type: string; title: string; prepared: boolean; missing: string[] };
export type EvidenceAssessment = { title: string; suggestion: string; checks: EvidenceCheck[]; canPreviewSubmission: boolean };

export function evidenceTitle(type: string): string {
  const titles: Record<string, string> = {
    PROOF_OF_FULFILLMENT: "Shipment or delivery proof", PROOF_OF_REFUND: "Refund proof", OTHER: "Supporting explanation or documents",
    PROOF_OF_DELIVERY_SIGNATURE: "Delivery signature", PROOF_OF_RECEIPT_COPY: "Receipt or invoice", RETURN_POLICY: "Return policy",
    BILLING_AGREEMENT: "Billing agreement", ITEM_DESCRIPTION: "Item description", PROOF_OF_RETURN: "Return shipment proof",
  };
  return titles[type] ?? type.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function rule(type: string, reason: string | null, requested: boolean): EvidenceRule {
  const common = { type, title: evidenceTitle(type), requested };
  if (!reason || !baseline[reason]) return { ...common, route: "manual", hint: "Confirm this case's evidence requirements manually; its reason is outside the baseline guide." };
  if (type === "PROOF_OF_FULFILLMENT") {
    return reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"
      ? { ...common, route: "tracking-or-document", hint: "Carrier + tracking, or a delivery document / explanatory note." }
      : { ...common, route: "tracking", hint: "Carrier and tracking are needed. Files alone do not replace these details." };
  }
  if (type === "PROOF_OF_REFUND") return { ...common, route: "refund", hint: "Provide an existing PayPal refund reference. A receipt alone is insufficient." };
  if (type === "OTHER") return { ...common, route: "notes-or-document", hint: "Add a case explanation or a relevant document." };
  // Types beyond the baseline must be checked against the specific case request.
  return { ...common, route: "manual", hint: "Prepare the requested document and review this evidence type manually." };
}

export function getEvidencePlan(dispute: Pick<DisputeDetail, "reason" | "requestedEvidence">): EvidencePlan {
  const profile = baseline[dispute.reason ?? ""];
  const requested = [...new Set(dispute.requestedEvidence)];
  return {
    title: profile?.title ?? "Case-specific evidence",
    context: profile?.context ?? "Check PayPal's request for this case before choosing evidence.",
    rules: (requested.length ? requested : profile?.types ?? ["OTHER"]).map((type) => rule(type, dispute.reason, requested.includes(type))),
    hasSellerRequest: requested.length > 0,
    baselineTypes: profile?.types ?? [],
  };
}

export function checkEvidence(rule: EvidenceRule, input?: EvidenceInput): EvidenceCheck {
  const hasNotes = !!input?.notes.trim();
  const hasFiles = !!input?.files.length;
  const hasTracking = !!input?.carrier.trim() && !!input?.trackingNumber.trim();
  let missing: string[];
  switch (rule.route) {
    case "tracking-or-document": missing = hasTracking || hasNotes || hasFiles ? [] : ["Add carrier and tracking, or a delivery document / explanatory note."]; break;
    case "tracking": missing = [!input?.carrier.trim() ? "Add the shipment carrier." : "", !input?.trackingNumber.trim() ? "Add the tracking number." : ""].filter(Boolean); break;
    case "refund": missing = input?.refundReference.trim() ? [] : ["Add the reference of an already issued PayPal refund."]; break;
    case "notes-or-document": missing = hasNotes || hasFiles ? [] : ["Add an explanation or supporting document."]; break;
    case "manual": missing = ["Review the exact evidence requirements manually before submitting."]; break;
  }
  if ((input?.notes.length ?? 0) > 2000) missing.push("Keep the evidence note within 2,000 characters.");
  return { type: rule.type, title: rule.title, prepared: !missing.length, missing };
}

export function assessEvidence(plan: EvidencePlan, inputs: Record<string, EvidenceInput>, canProvideEvidence: boolean): EvidenceAssessment {
  // Reference options are alternatives, not a requirement to submit every type.
  const target = plan.hasSellerRequest ? plan.rules : plan.rules.filter((item) => {
    const input = inputs[item.type];
    return input && (input.notes.trim() || input.carrier.trim() || input.trackingNumber.trim() || input.refundReference.trim() || input.files.length);
  });
  const checks = target.map((item) => checkEvidence(item, inputs[item.type]));
  const missing = checks.some((item) => !item.prepared);
  const canPreviewSubmission = canProvideEvidence && plan.hasSellerRequest && checks.length > 0 && !missing;
  return {
    title: !checks.length ? "Choose evidence to prepare." : missing ? "More evidence is needed." : "Your draft is ready for review.",
    suggestion: !plan.hasSellerRequest ? "Confirm the case-specific seller request with PayPal. The reason guide lists reference options only."
      : missing ? "Collect the missing items below, then run the check again."
      : !canProvideEvidence ? "Review the evidence draft. PayPal is not currently offering evidence submission for this case."
      : "Review the document contents and case facts before submitting evidence. Selected files have not been verified or sent.",
    checks,
    canPreviewSubmission,
  };
}

export function validateEvidenceFiles<T extends EvidenceFile>(existing: EvidenceFile[], candidates: T[]): { accepted: T[]; errors: string[] } {
  const mimeTypes: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", png: "image/png", pdf: "application/pdf" };
  let total = existing.reduce((sum, file) => sum + file.size, 0);
  const accepted: T[] = [];
  const errors: string[] = [];
  for (const file of candidates) {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!mimeTypes[extension] || (file.type && file.type !== mimeTypes[extension])) errors.push(`${file.name}: use JPG, JPEG, GIF, PNG, or PDF.`);
    else if (!Number.isFinite(file.size) || file.size <= 0 || file.size >= MAX_FILE_BYTES) errors.push(`${file.name}: each file must be nonempty and smaller than 10 MB.`);
    else if (total + file.size > MAX_TOTAL_BYTES) errors.push(`${file.name}: the case's selected files would exceed 50 MB.`);
    else { accepted.push(file); total += file.size; }
  }
  return { accepted, errors };
}
