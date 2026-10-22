import "server-only";
import { isSameOriginRequest } from "../request-origin";
import { getBinding, KnowledgeError } from "./config";
import { getPool, postgresDatabase } from "./database";
import { KnowledgeRepository } from "./repository";

export const knowledgeHeaders = { "Cache-Control": "private, no-store" };
export function knowledgeRepository() {
  return new KnowledgeRepository(postgresDatabase(getPool()), getBinding());
}

export function knowledgeErrorResponse(error: unknown) {
  if (error instanceof KnowledgeError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: knowledgeHeaders });
  // Never return raw database/provider errors, connection strings, or credentials.
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "23505") return Response.json({ error: { code: "DOCUMENT_EXISTS", message: "A document with this name already exists. Refresh the document list and use its Update action." } }, { status: 409, headers: knowledgeHeaders });
  const message = code === "42P01" || code === "42704"
    ? "Knowledge database is not initialized. Run npm run db:migrate with pgvector available."
    : "Unable to access the knowledge database. Check DATABASE_URL and PostgreSQL availability.";
  return Response.json({ error: { code: "KNOWLEDGE_UNAVAILABLE", message } }, { status: 503, headers: knowledgeHeaders });
}

export function validateDocId(id: string) {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) throw new KnowledgeError("INVALID_DOCUMENT_ID", "Invalid document ID.", 400);
}

export function requireSameOrigin(request: Request) {
  if (!isSameOriginRequest(request)) throw new KnowledgeError("ORIGIN_NOT_ALLOWED", "Cross-origin knowledge requests are not allowed.", 403);
}
