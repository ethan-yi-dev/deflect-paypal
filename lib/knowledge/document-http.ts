import { KnowledgeError } from "./config";
import { prepareFile, prepareText } from "./document-source";
import { MAX_PDF_BYTES } from "./types";

export async function readDocumentSource(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data") && !contentType.startsWith("application/json")) {
    throw new KnowledgeError("INVALID_UPLOAD", "Send a multipart file or JSON with name and text.", 400);
  }
  const limit = MAX_PDF_BYTES + 1024 * 1024;
  if (Number(request.headers.get("content-length")) > limit) throw new KnowledgeError("FILE_TOO_LARGE", "Each document must be 50 MB or smaller.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new KnowledgeError("INVALID_UPLOAD", "Choose a document or enter text.", 400);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new KnowledgeError("FILE_TOO_LARGE", "Each document must be 50 MB or smaller.", 413);
    }
    parts.push(new Uint8Array(next.value));
  }
  const response = new Response(new Blob(parts), { headers: { "Content-Type": contentType } });
  if (contentType.startsWith("application/json")) {
    let value;
    try { value = await response.json() as { name?: unknown; text?: unknown }; }
    catch { throw new KnowledgeError("INVALID_UPLOAD", "Send valid JSON with name and text.", 400); }
    if (!value || typeof value.name !== "string" || typeof value.text !== "string") throw new KnowledgeError("INVALID_UPLOAD", "Send a document name and text content.", 400);
    return prepareText(value.name, value.text);
  }
  let form;
  try { form = await response.formData(); }
  catch { throw new KnowledgeError("INVALID_UPLOAD", "The upload form could not be read.", 400); }
  const file = form.get("file");
  if (!(file instanceof File) || form.getAll("file").length !== 1) throw new KnowledgeError("INVALID_UPLOAD", "Upload one document per request.", 400);
  return prepareFile(file.name, new Uint8Array(await file.arrayBuffer()));
}

export function expectedDocumentHash(request: Request) {
  const value = request.headers.get("if-match");
  if (!value) throw new KnowledgeError("HASH_REQUIRED", "Send the current document contentHash in the If-Match header before updating.", 428);
  const match = /^(?:"([a-f0-9]{64})"|([a-f0-9]{64}))$/.exec(value);
  if (!match) throw new KnowledgeError("INVALID_HASH", "If-Match must contain the current SHA-256 hash.", 400);
  return match[1] ?? match[2];
}
