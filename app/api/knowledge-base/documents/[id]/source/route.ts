import { knowledgeErrorResponse, knowledgeHeaders, knowledgeRepository, validateDocId } from "@/lib/knowledge/server";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    validateDocId(id);
    const document = await knowledgeRepository().source(id);
    return new Response(new Uint8Array(document.source_data), { headers: {
      ...knowledgeHeaders, "Content-Type": document.content_type, "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(document.name).replaceAll("'", "%27")}`,
    } });
  } catch (error) { return knowledgeErrorResponse(error); }
}
