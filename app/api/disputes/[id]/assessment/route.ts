import { getAssessmentConfig, AssessmentError } from "@/lib/assessment/config";
import { readAssessmentUpload, requireAssessmentOrigin } from "@/lib/assessment/input";
import { assessCase } from "@/lib/assessment/service";
import { getEmbeddingConfig, getRerankConfig } from "@/lib/knowledge/config";
import { createKnowledgeProviders } from "@/lib/knowledge/providers";
import { createCohereReranker } from "@/lib/knowledge/reranker";
import { retrieveKnowledge } from "@/lib/knowledge/retrieval";
import { knowledgeRepository } from "@/lib/knowledge/server";
import { paypalDisputes, disputeResponseHeaders } from "@/lib/paypal-disputes";
import { PayPalDisputesError } from "@/lib/paypal-disputes-client";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAssessmentOrigin(request);
    const { id } = await params;
    if (!/^[A-Za-z0-9-]{1,255}$/.test(id)) throw new AssessmentError("INVALID_DISPUTE_ID", "Enter a valid dispute ID.", 400);
    // Fail on placeholder credentials before reading attachments or invoking providers.
    const config = getAssessmentConfig();
    const upload = await readAssessmentUpload(request);
    const dispute = await paypalDisputes.getDispute(id);
    const result = await assessCase(dispute, upload, config, request.signal, async (query, limit, signal) => {
      const repository = knowledgeRepository();
      const binding = await repository.ensureBase();
      const rerankConfig = getRerankConfig();
      return retrieveKnowledge({ query, limit, signal, repository, config: rerankConfig,
        providers: createKnowledgeProviders(binding, getEmbeddingConfig()), reranker: createCohereReranker(rerankConfig) });
    });
    return Response.json(result, { headers: disputeResponseHeaders });
  } catch (error) {
    if (error instanceof AssessmentError || error instanceof PayPalDisputesError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: disputeResponseHeaders });
    if (request.signal.aborted) return Response.json({ error: { code: "ASSESSMENT_CANCELLED", message: "Assessment cancelled." } }, { status: 499, headers: disputeResponseHeaders });
    return Response.json({ error: { code: "ASSESSMENT_FAILED", message: "Unable to assess this case. Please try again." } }, { status: 500, headers: disputeResponseHeaders });
  }
}
