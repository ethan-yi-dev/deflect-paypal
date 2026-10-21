import { createHash } from "node:crypto";
import { KnowledgeError } from "./config";
import { MAX_PDF_BYTES, type KnowledgeContentType } from "./types";

export type DocumentSource = {
  name: string; size: number; contentType: KnowledgeContentType;
  pdf: Buffer | null; text: string | null; hash: string;
};

export function prepareFile(name: string, bytes: Uint8Array): DocumentSource {
  const extension = name.split(".").pop()?.toLowerCase();
  if (!name.trim() || name.length > 255 || /[/\\\x00-\x1f]/.test(name) || !["pdf", "txt", "md"].includes(extension ?? "")) {
    throw new KnowledgeError("INVALID_DOCUMENT", "Choose a PDF, TXT, or MD document with a filename of at most 255 characters.", 400);
  }
  if (!bytes.length || bytes.length > MAX_PDF_BYTES) throw new KnowledgeError("INVALID_DOCUMENT", "Choose a nonempty document up to 50 MB.", 400);
  const data = Buffer.from(bytes);
  let text: string | null = null;
  if (extension === "pdf") {
    if (data.subarray(0, 5).toString("ascii") !== "%PDF-") throw new KnowledgeError("INVALID_PDF", "Choose a valid PDF document.", 400);
  } else {
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); }
    catch { throw new KnowledgeError("INVALID_TEXT", "Text documents must use UTF-8 encoding.", 400); }
    if (!text.trim() || text.includes("\0")) throw new KnowledgeError("INVALID_TEXT", "Text documents must contain readable, nonempty text.", 400);
  }
  return {
    name, size: data.length, contentType: extension === "pdf" ? "application/pdf" : extension === "md" ? "text/markdown" : "text/plain",
    pdf: extension === "pdf" ? data : null, text, hash: createHash("sha256").update(data).digest("hex"),
  };
}

export function prepareText(name: string, text: string) {
  if (!name.trim()) throw new KnowledgeError("INVALID_DOCUMENT", "Enter a document name.", 400);
  const filename = /\.(txt|md)$/i.test(name) ? name : `${name}.txt`;
  return prepareFile(filename, Buffer.from(text, "utf8"));
}
