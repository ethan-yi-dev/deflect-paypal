import { AssessmentError } from "@/lib/assessment/config";
import { readAssessmentUpload, requireAssessmentOrigin } from "@/lib/assessment/input";
import { evidenceCredentials, EvidenceSubmissionError } from "@/lib/evidence/package";
import { EvidenceSubmissionRepository } from "@/lib/evidence/repository";
import { previewEvidence, submitEvidence } from "@/lib/evidence/service";
import { getPool, postgresDatabase } from "@/lib/knowledge/database";
import { paypalDisputes, disputeResponseHeaders } from "@/lib/paypal-disputes";
import { PayPalDisputesError } from "@/lib/paypal-disputes-client";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAssessmentOrigin(request);
    const { id } = await params;
    if (!/^[A-Za-z0-9-]{1,255}$/.test(id)) throw new EvidenceSubmissionError("INVALID_DISPUTE_ID", "Enter a valid dispute ID.");
    const mode = request.headers.get("x-evidence-mode") ?? "preview";
    if (mode !== "preview" && mode !== "submit") throw new EvidenceSubmissionError("INVALID_SUBMISSION_MODE", "Choose preview or submit.");
    const credentials = evidenceCredentials();
    const upload = await readAssessmentUpload(request);
    const deps = { credentials, client: paypalDisputes, repository: new EvidenceSubmissionRepository(postgresDatabase(getPool())) };
    const result = mode === "preview" ? await previewEvidence(id, upload, deps)
      : await submitEvidence(id, upload, request.headers.get("x-evidence-review"), deps, request.signal);
    return Response.json(result, { headers: disputeResponseHeaders });
  } catch (error) {
    if (error instanceof EvidenceSubmissionError || error instanceof AssessmentError || error instanceof PayPalDisputesError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: disputeResponseHeaders });
    if (request.signal.aborted) return Response.json({ error: { code: "EVIDENCE_REQUEST_CANCELLED", message: "The evidence review was cancelled. If a submission was already confirmed, check the case before retrying." } }, { status: 499, headers: disputeResponseHeaders });
    return Response.json({ error: { code: "EVIDENCE_STORAGE_UNAVAILABLE", message: "Evidence submission records are unavailable. Check PostgreSQL and run npm run db:migrate before submitting evidence." } }, { status: 503, headers: disputeResponseHeaders });
  }
}
