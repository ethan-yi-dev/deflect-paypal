import type { Database } from "../knowledge/database";
import type { EvidenceReceipt } from "../paypal-evidence";
import { EvidenceSubmissionError, type EvidenceReview } from "./package";

export type EvidenceSubmissionRecord = { id: string; scope: string; disputeId: string; caseHash: string; payloadHash: string; state: "pending" | "submitted" | "rejected" | "unknown"; receipt: EvidenceReceipt | null };
const fields = `id, merchant_scope AS scope, dispute_id AS "disputeId", case_hash AS "caseHash", payload_hash AS "payloadHash", state, receipt`;

export class EvidenceSubmissionRepository {
  constructor(private db: Pick<Database, "query">) {}
  async ready() { await this.db.query("SELECT id FROM t_evidence_submission LIMIT 0"); }
  async get(review: EvidenceReview) {
    const [row] = await this.db.query<EvidenceSubmissionRecord>(`SELECT ${fields} FROM t_evidence_submission WHERE id=$1 AND merchant_scope=$2 AND dispute_id=$3`, [review.id, review.scope, review.disputeId]);
    return row ?? null;
  }
  async reserve(review: EvidenceReview): Promise<{ acquired: boolean; record: EvidenceSubmissionRecord }> {
    const [inserted] = await this.db.query<EvidenceSubmissionRecord>(`INSERT INTO t_evidence_submission (id, merchant_scope, dispute_id, case_hash, payload_hash, state) VALUES ($1,$2,$3,$4,$5,'pending') ON CONFLICT DO NOTHING RETURNING ${fields}`, [review.id, review.scope, review.disputeId, review.caseHash, review.payloadHash]);
    if (inserted) return { acquired: true, record: inserted };
    const [existing] = await this.db.query<EvidenceSubmissionRecord>(`SELECT ${fields} FROM t_evidence_submission WHERE merchant_scope=$1 AND dispute_id=$2 AND (id=$3 OR state IN ('pending','unknown') OR (case_hash=$4 AND payload_hash=$5 AND state='submitted')) ORDER BY CASE WHEN id=$3 THEN 0 ELSE 1 END, created_at LIMIT 1`, [review.scope, review.disputeId, review.id, review.caseHash, review.payloadHash]);
    if (!existing) throw new EvidenceSubmissionError("EVIDENCE_SUBMISSION_BUSY", "Another evidence submission is being recorded. Refresh the case before continuing.", 409);
    return { acquired: false, record: existing };
  }
  async submitted(review: EvidenceReview, receipt: EvidenceReceipt) {
    const rows = await this.db.query(`UPDATE t_evidence_submission SET state='submitted', receipt=$2::jsonb, updated_at=now() WHERE id=$1 AND state='pending' RETURNING id`, [review.id, JSON.stringify(receipt)]);
    if (!rows.length) throw new EvidenceSubmissionError("EVIDENCE_RECEIPT_NOT_SAVED", "The PayPal response could not be recorded. Refresh the case before any further submission.", 503);
  }
  async failed(review: EvidenceReview, state: "rejected" | "unknown", code: string) {
    await this.db.query("UPDATE t_evidence_submission SET state=$2, error_code=$3, updated_at=now() WHERE id=$1 AND state='pending'", [review.id, state, code]);
  }
}
