import { expectedDocumentHash, readDocumentSource } from "@/lib/knowledge/document-http";
import { knowledgeErrorResponse, knowledgeHeaders, knowledgeRepository, requireSameOrigin, validateDocId } from "@/lib/knowledge/server";

export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const { id } = await context.params;
    validateDocId(id);
    const result = await knowledgeRepository().deleteDocument(id);
    return Response.json(result, { headers: knowledgeHeaders });
  } catch (error) { return knowledgeErrorResponse(error); }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const { id } = await context.params;
    validateDocId(id);
    const hash = expectedDocumentHash(request);
    const source = await readDocumentSource(request);
    const result = await knowledgeRepository().updateDocument(id, source, hash);
    return Response.json(result, { headers: knowledgeHeaders });
  } catch (error) { return knowledgeErrorResponse(error); }
}
