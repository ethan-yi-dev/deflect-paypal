import { getProviderConfig } from "@/lib/knowledge/config";
import { processKnowledgeDocument } from "@/lib/knowledge/processing";
import { createKnowledgeProviders } from "@/lib/knowledge/providers";
import { knowledgeErrorResponse, knowledgeHeaders, knowledgeRepository, requireSameOrigin, validateDocId } from "@/lib/knowledge/server";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const { id } = await context.params;
    validateDocId(id);
    const config = getProviderConfig();
    const repository = knowledgeRepository();
    const document = await processKnowledgeDocument(repository, id, createKnowledgeProviders(repository.binding, config), request.signal);
    return Response.json({ document }, { headers: knowledgeHeaders });
  } catch (error) { return knowledgeErrorResponse(error); }
}
