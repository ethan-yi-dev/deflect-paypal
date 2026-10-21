import { knowledgeErrorResponse, knowledgeHeaders, knowledgeRepository, validateDocId } from "@/lib/knowledge/server";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    validateDocId(id);
    const document = await knowledgeRepository().pdf(id);
    return new Response(new Uint8Array(document.pdf_data), { headers: {
      ...knowledgeHeaders, "Content-Type": "application/pdf", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(document.name).replaceAll("'", "%27")}`,
    } });
  } catch (error) { return knowledgeErrorResponse(error); }
}
