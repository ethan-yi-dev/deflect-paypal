import { KnowledgeError } from "@/lib/knowledge/config";
import { knowledgeErrorResponse, knowledgeHeaders, knowledgeRepository, requireSameOrigin } from "@/lib/knowledge/server";
import { MAX_PDF_BYTES } from "@/lib/knowledge/types";

export const runtime = "nodejs";

export async function GET() {
  try { return Response.json(await knowledgeRepository().list(), { headers: knowledgeHeaders }); }
  catch (error) { return knowledgeErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) throw new KnowledgeError("INVALID_UPLOAD", "Upload a PDF using multipart/form-data.", 400);
    const declaredSize = Number(request.headers.get("content-length"));
    if (declaredSize > MAX_PDF_BYTES + 1024 * 1024) throw new KnowledgeError("FILE_TOO_LARGE", "Each PDF must be 50 MB or smaller.", 413);
    // Bound the streamed request too; content-length alone cannot enforce a limit.
    const reader = request.body?.getReader();
    if (!reader) throw new KnowledgeError("INVALID_UPLOAD", "Choose a PDF to upload.", 400);
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PDF_BYTES + 1024 * 1024) {
        await reader.cancel();
        throw new KnowledgeError("FILE_TOO_LARGE", "Each PDF must be 50 MB or smaller.", 413);
      }
      parts.push(new Uint8Array(next.value));
    }
    const form = await new Response(new Blob(parts), { headers: { "Content-Type": request.headers.get("content-type")! } }).formData();
    const file = form.get("file");
    if (!(file instanceof File) || form.getAll("file").length !== 1) throw new KnowledgeError("INVALID_UPLOAD", "Upload one PDF per request.", 400);
    if (file.size > MAX_PDF_BYTES) throw new KnowledgeError("FILE_TOO_LARGE", "Each PDF must be 50 MB or smaller.", 413);
    const document = await knowledgeRepository().upload(file.name, new Uint8Array(await file.arrayBuffer()));
    return Response.json({ document }, { status: 201, headers: knowledgeHeaders });
  } catch (error) {
    if (error instanceof TypeError) return knowledgeErrorResponse(new KnowledgeError("INVALID_UPLOAD", "The upload form could not be read. Choose a PDF and try again.", 400));
    return knowledgeErrorResponse(error);
  }
}
