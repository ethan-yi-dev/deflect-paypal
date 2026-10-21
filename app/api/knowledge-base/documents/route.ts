import { readDocumentSource } from "@/lib/knowledge/document-http";
import { knowledgeErrorResponse, knowledgeHeaders, knowledgeRepository, requireSameOrigin } from "@/lib/knowledge/server";

export const runtime = "nodejs";

export async function GET() {
  try { return Response.json(await knowledgeRepository().list(), { headers: knowledgeHeaders }); }
  catch (error) { return knowledgeErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const source = await readDocumentSource(request);
    const result = await knowledgeRepository().createDocument(source);
    return Response.json(result, { status: result.changed ? 201 : 200, headers: knowledgeHeaders });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
