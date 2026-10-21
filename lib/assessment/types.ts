import type { KnowledgeRetrieval } from "../knowledge/types";

export const MAX_ASSESSMENT_FILES = 12;
export const ASSESSMENT_ACTIONS = ["gather_evidence", "manual_review", "provide_evidence", "send_message", "make_offer", "accept_claim", "escalate"] as const;
export type AssessmentAction = typeof ASSESSMENT_ACTIONS[number];
export type CitedStatement = { text: string; sourceIds: string[] };
export type AssessmentSource = {
  id: string;
  kind: "case" | "merchant_input" | "evidence" | "policy";
  authority: "paypal_record" | "buyer_statement" | "merchant_statement" | "unattributed_statement" | "uploaded_evidence" | "unclassified_policy";
  title: string;
  content: string;
  pageNumber: number | null;
  documentId: string | null;
  chunkId: string | null;
};
export type CaseAssessment = {
  summary: CitedStatement;
  buyerClaim: CitedStatement;
  supportedFacts: CitedStatement[];
  supportingEvidence: CitedStatement[];
  conflictingEvidence: CitedStatement[];
  applicablePolicies: CitedStatement[];
  missingEvidence: { item: string; why: string; priority: "high" | "medium" | "low"; sourceIds: string[] }[];
  uncertainties: string[];
  recommendation: {
    action: AssessmentAction;
    title: string;
    rationale: CitedStatement[];
    responseDraft: CitedStatement[];
    reconsiderWhen: string[];
  };
};
export type CaseAssessmentResult = {
  assessment: CaseAssessment;
  sources: AssessmentSource[];
  generatedAt: string;
  model: string;
  snapshotHash: string;
  caseUpdatedAt: string | null;
  retrieval: { query: string; limit: number; hitCount: number; status: "available" | "unavailable"; details: KnowledgeRetrieval | null };
  warnings: string[];
};
