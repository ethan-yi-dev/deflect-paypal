import { getProviderConfig } from "@/lib/knowledge/config";
import { knowledgeErrorResponse, knowledgeHeaders, knowledgeRepository, requireSameOrigin, validateDocId } from "@/lib/knowledge/server";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const { id } = await context.params;
    validateDocId(id);
    getProviderConfig();
    const document = await knowledgeRepository().startIndexing(id);
    return Response.json({ document }, { status: 202, headers: knowledgeHeaders });
  } catch (error) { return knowledgeErrorResponse(error); }
}
