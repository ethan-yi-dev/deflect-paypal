import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, validateEvidenceFiles } from "../dispute-evidence";
import { isSameOriginRequest } from "../request-origin";
import { AssessmentError } from "./config";
import { MAX_ASSESSMENT_FILES } from "./types";

export type MerchantEvidenceInput = { type: string; notes: string; carrier: string; trackingNumber: string; refundReference: string; fileKeys: string[] };
export type AssessmentUpload = { inputs: MerchantEvidenceInput[]; files: Map<string, File> };

export function requireAssessmentOrigin(request: Request) {
  if (!isSameOriginRequest(request)) throw new AssessmentError("ORIGIN_NOT_ALLOWED", "Cross-origin assessment requests are not allowed.", 403);
}

export async function readAssessmentUpload(request: Request): Promise<AssessmentUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) throw new AssessmentError("INVALID_ASSESSMENT_INPUT", "Send case notes and evidence as multipart form data.", 400);
  const limit = MAX_TOTAL_BYTES + 256000;
  if (Number(request.headers.get("content-length")) > limit) throw new AssessmentError("ASSESSMENT_TOO_LARGE", "Keep selected evidence within 50 MB.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AssessmentError("INVALID_ASSESSMENT_INPUT", "The evidence form is missing.", 400);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new AssessmentError("ASSESSMENT_TOO_LARGE", "Keep selected evidence within 50 MB.", 413);
    }
    chunks.push(new Uint8Array(next.value));
  }
  let form: FormData;
  try { form = await new Response(new Blob(chunks), { headers: { "Content-Type": contentType } }).formData(); }
  catch { throw new AssessmentError("INVALID_ASSESSMENT_INPUT", "The evidence form could not be read.", 400); }
  const metadata = form.get("inputs");
  if (typeof metadata !== "string" || metadata.length > 100000 || form.getAll("inputs").length !== 1) throw new AssessmentError("INVALID_ASSESSMENT_INPUT", "Send one evidence input list.", 400);
  let raw: unknown;
  try { raw = JSON.parse(metadata); } catch { throw new AssessmentError("INVALID_ASSESSMENT_INPUT", "The evidence input list is invalid.", 400); }
  if (!Array.isArray(raw) || raw.length > 20) throw new AssessmentError("INVALID_ASSESSMENT_INPUT", "Send at most 20 evidence groups.", 400);
  const types = new Set<string>();
  const keys = new Set<string>();
  const inputs: MerchantEvidenceInput[] = raw.map((value) => {
    if (!value || typeof value !== "object" || typeof value.type !== "string" || !/^[A-Z_]{1,100}$/.test(value.type) || types.has(value.type)) throw new AssessmentError("INVALID_ASSESSMENT_INPUT", "Each evidence group must have a unique evidence type.", 400);
    types.add(value.type);
    for (const [field, max] of [["notes", 2000], ["carrier", 2000], ["trackingNumber", 255], ["refundReference", 255]] as const) {
      if (typeof value[field] !== "string" || value[field].length > max) throw new AssessmentError("INVALID_ASSESSMENT_INPUT", `Evidence ${field} must be text within ${max} characters.`, 400);
    }
    if (!Array.isArray(value.fileKeys)) throw new AssessmentError("INVALID_ASSESSMENT_INPUT", "Send a file reference list for each evidence group.", 400);
    for (const key of value.fileKeys) {
      if (typeof key !== "string" || !/^file-\d{1,2}$/.test(key) || keys.has(key)) throw new AssessmentError("INVALID_ASSESSMENT_INPUT", "Evidence files must have unique references.", 400);
      keys.add(key);
    }
    return { type: value.type, notes: value.notes.trim(), carrier: value.carrier.trim(), trackingNumber: value.trackingNumber.trim(), refundReference: value.refundReference.trim(), fileKeys: value.fileKeys };
  });
  if (keys.size > MAX_ASSESSMENT_FILES) throw new AssessmentError("TOO_MANY_FILES", `Choose at most ${MAX_ASSESSMENT_FILES} evidence files per assessment.`, 400);
  const files = new Map<string, File>();
  for (const [key, value] of form.entries()) {
    if (key === "inputs") continue;
    if (!keys.has(key) || !(value instanceof File) || files.has(key)) throw new AssessmentError("INVALID_ASSESSMENT_INPUT", "The evidence files do not match the input list.", 400);
    if (!value.name.trim() || value.name.length > 255 || /[/\\\x00-\x1f]/.test(value.name)) throw new AssessmentError("INVALID_EVIDENCE_FILE", "Use a filename of at most 255 characters without path separators.", 400);
    files.set(key, value);
  }
  if (files.size !== keys.size) throw new AssessmentError("INVALID_ASSESSMENT_INPUT", "An evidence attachment is missing.", 400);
  const { errors } = validateEvidenceFiles([], [...files.values()]);
  if (errors.length) throw new AssessmentError("INVALID_EVIDENCE_FILE", errors.join(" "), 400);
  return { inputs, files };
}

export async function readEvidenceBytes(file: File): Promise<{ bytes: Buffer; mime: string }> {
  if (file.size <= 0 || file.size >= MAX_FILE_BYTES) throw new AssessmentError("INVALID_EVIDENCE_FILE", "Each evidence file must be nonempty and smaller than 10 MB.", 400);
  const bytes = Buffer.from(await file.arrayBuffer());
  const extension = file.name.split(".").pop()?.toLowerCase();
  const matches = extension === "pdf" ? bytes.subarray(0, 5).toString("ascii") === "%PDF-"
    : extension === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : extension === "jpg" || extension === "jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : extension === "gif" ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")) : false;
  if (!matches) throw new AssessmentError("INVALID_EVIDENCE_FILE", `${file.name}: the file contents do not match its extension.`, 400);
  // Vision accepts static GIFs only. Detect animation control extensions before sending.
  if (extension === "gif" && (bytes.includes(Buffer.from("NETSCAPE2.0")) || bytes.includes(Buffer.from("ANIMEXTS1.0"))
      || bytes.indexOf(Buffer.from([0x21, 0xf9, 0x04])) !== bytes.lastIndexOf(Buffer.from([0x21, 0xf9, 0x04])))) {
    throw new AssessmentError("ANIMATED_GIF_UNSUPPORTED", `${file.name}: upload a static image or PDF for assessment.`, 400);
  }
  const mime = extension === "pdf" ? "application/pdf" : extension === "png" ? "image/png" : extension === "gif" ? "image/gif" : "image/jpeg";
  return { bytes, mime };
}
