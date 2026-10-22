import type { DisputeDetail } from "./disputes";

export type PayPalEvidence = {
  evidence_type: string;
  notes?: string;
  evidence_info?: { tracking_info?: { carrier_name: string; carrier_name_other?: string; tracking_number: string }[]; refund_ids?: string[] };
  documents?: { name: string }[];
};
export type EvidencePreviewItem = {
  type: string; title: string; notes: string; carrier: string; trackingNumber: string; refundReference: string;
  documents: { name: string; uploadName: string; size: number }[];
};
export type EvidenceSubmissionPreview = {
  reviewToken: string; expiresAt: string; disputeId: string; environment: "sandbox";
  caseUpdatedAt: string | null; evidences: EvidencePreviewItem[];
};
export type EvidenceReceipt = {
  submissionId: string; disputeId: string; status: "submitted"; environment: "sandbox"; submittedAt: string; debugId: string | null;
};
export type EvidenceSubmissionResult = EvidenceReceipt & { dispute: DisputeDetail | null; refreshWarning: string | null };
