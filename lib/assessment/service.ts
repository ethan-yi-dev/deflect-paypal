import type { DisputeDetail } from "../disputes";
import type { KnowledgeSearchResult } from "../knowledge/types";
import type { AssessmentConfig } from "./config";
import { buildAssessmentContext, buildRetrievalQuery } from "./context";
import type { AssessmentUpload } from "./input";
import { requestOpenAIAssessment } from "./openai";
import type { CaseAssessmentResult } from "./types";

export async function assessCase(dispute: DisputeDetail, upload: AssessmentUpload, config: AssessmentConfig, signal: AbortSignal,
  retrieve: (query: string, limit: number, signal: AbortSignal) => Promise<KnowledgeSearchResult>, fetcher: typeof fetch = fetch): Promise<CaseAssessmentResult> {
  const query = buildRetrievalQuery(dispute, upload.inputs);
  const warnings: string[] = [];
  let knowledge: KnowledgeSearchResult | null = null;
  try {
    knowledge = await retrieve(query, config.topK, signal);
    if (knowledge.retrieval.warning) warnings.push(knowledge.retrieval.warning);
    if (!knowledge.hits.length) warnings.push("No indexed policy passages were found. The assessment can use case facts and uploaded evidence only.");
  } catch {
    signal.throwIfAborted();
    warnings.push("Policy retrieval is unavailable. Check the knowledge database and embedding configuration. This assessment uses case facts and uploaded evidence only.");
  }
  const context = await buildAssessmentContext(dispute, upload, knowledge?.hits ?? []);
  signal.throwIfAborted();
  const assessedAt = new Date().toISOString();
  const assessment = await requestOpenAIAssessment(context, warnings, assessedAt, config, signal, fetcher);
  return { assessment, sources: context.sources, generatedAt: new Date().toISOString(), model: config.model, snapshotHash: context.snapshotHash,
    caseUpdatedAt: dispute.updatedAt, warnings,
    retrieval: { query, limit: config.topK, hitCount: knowledge?.hits.length ?? 0, status: knowledge ? "available" : "unavailable", details: knowledge?.retrieval ?? null } };
}
