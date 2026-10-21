export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export type KnowledgeStatus = "pending" | "running" | "success" | "failed";
export type ModelBinding = { id: string; embeddingModel: string; embeddingDimensions: number };
export type KnowledgeDocument = {
  id: string;
  name: string;
  size: number;
  status: KnowledgeStatus;
  embeddingModel: string;
  chunkCount: number;
  errorMessage: string | null;
  uploadedAt: string;
  indexedAt: string | null;
};
export type KnowledgeList = { knowledgeBase: ModelBinding; documents: KnowledgeDocument[] };
export type ParsedPage = { pageNumber: number; text: string };
export type KnowledgeChunk = ParsedPage & { embedding: number[] };
export type SearchHit = { id: string; docId: string; documentName: string; content: string; pageNumber: number; score: number };
