import { setTimeout as delay } from "node:timers/promises";
import { SentenceSplitter } from "@llamaindex/core/node-parser";
import { getProviderConfig, KnowledgeError } from "./config";
import { validateVector } from "./repository";
import type { ModelBinding, ParsedPage } from "./types";

type ProviderConfig = ReturnType<typeof getProviderConfig>;
export type KnowledgeProviders = {
  parse: (pdf: Uint8Array, name: string, signal: AbortSignal) => Promise<ParsedPage[]>;
  embed: (text: string, purpose: "document" | "query", title: string, signal: AbortSignal) => Promise<number[]>;
};

export function chunkPages(pages: ParsedPage[]): ParsedPage[] {
  const splitter = new SentenceSplitter({ chunkSize: 512, chunkOverlap: 64 });
  const chunks = pages.flatMap((page) => splitter.splitText(page.text).filter((text) => text.trim()).map((text) => ({ pageNumber: page.pageNumber, text })));
  if (!chunks.length) throw new KnowledgeError("EMPTY_DOCUMENT", "No searchable text was found in this PDF.", 422);
  return chunks;
}

export function createKnowledgeProviders(binding: ModelBinding, config: ProviderConfig, fetcher: typeof fetch = fetch,
  pause = (signal: AbortSignal) => delay(2000, undefined, { signal })): KnowledgeProviders {
  async function request<T>(url: string, init: RequestInit, signal: AbortSignal, provider: string): Promise<T> {
    let response: Response;
    try { response = await fetcher(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) }); }
    catch { throw new KnowledgeError("PROVIDER_UNREACHABLE", `${provider} could not be reached or timed out. Please retry.`, 502); }
    if (!response.ok) throw new KnowledgeError("PROVIDER_ERROR", `${provider} returned HTTP ${response.status}. Check its credentials, quota, and service availability.`, 502);
    try { return await response.json() as T; }
    catch { throw new KnowledgeError("PROVIDER_RESPONSE_INVALID", `${provider} returned an unreadable response.`, 502); }
  }

  return {
    async parse(pdf, name, signal) {
      const parseSignal = AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]);
      const headers = { Authorization: `Bearer ${config.llamaKey}`, Accept: "application/json" };
      const form = new FormData();
      form.set("purpose", "parse");
      form.set("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), name);
      const file = await request<{ id: string }>("https://api.cloud.llamaindex.ai/api/v1/beta/files", { method: "POST", headers, body: form }, parseSignal, "LlamaParse upload");
      if (typeof file.id !== "string" || !file.id) throw new KnowledgeError("INVALID_PARSE_RESPONSE", "LlamaParse did not return a file ID.", 502);
      const job = await request<{ id: string }>("https://api.cloud.llamaindex.ai/api/v2/parse", {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: file.id, tier: config.tier, version: "latest" }),
      }, parseSignal, "LlamaParse");
      if (typeof job.id !== "string" || !job.id) throw new KnowledgeError("INVALID_PARSE_RESPONSE", "LlamaParse did not return a job ID.", 502);
      while (true) {
        parseSignal.throwIfAborted();
        const result = await request<{
          job?: { status: string };
          markdown?: { pages?: { page_number: number; markdown: string; success?: boolean }[] };
        }>(`https://api.cloud.llamaindex.ai/api/v2/parse/${encodeURIComponent(job.id)}?expand=markdown`, { headers }, parseSignal, "LlamaParse");
        if (result.job?.status === "COMPLETED") {
          const pages = result.markdown?.pages;
          if (!Array.isArray(pages) || !pages.length || pages.some((page) => page.success === false || typeof page.markdown !== "string" || !Number.isInteger(page.page_number) || page.page_number < 1)) {
            throw new KnowledgeError("INVALID_PARSE_RESULT", "LlamaParse returned missing or incomplete pages. Retry parsing this PDF.", 502);
          }
          return pages.map((page) => ({ pageNumber: page.page_number, text: page.markdown }));
        }
        if (result.job?.status === "FAILED" || result.job?.status === "CANCELLED") throw new KnowledgeError("PARSE_FAILED", "LlamaParse could not parse this PDF. Check the PDF and retry.", 502);
        if (result.job?.status !== "PENDING" && result.job?.status !== "RUNNING") throw new KnowledgeError("INVALID_PARSE_STATUS", "LlamaParse returned an unknown job status.", 502);
        await pause(parseSignal);
      }
    },

    async embed(text, purpose, title, signal) {
      const modern = binding.embeddingModel === "gemini-embedding-2";
      const input = modern
        ? purpose === "query" ? `task: search result | query: ${text}` : `title: ${title || "none"} | text: ${text}`
        : text;
      const response = await request<{ embedding?: { values?: number[] } }>(`https://generativelanguage.googleapis.com/v1beta/models/${binding.embeddingModel}:embedContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": config.geminiKey },
        body: JSON.stringify({
          model: `models/${binding.embeddingModel}`, content: { parts: [{ text: input }] },
          outputDimensionality: binding.embeddingDimensions,
          ...(!modern ? { taskType: purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT", ...(purpose === "document" ? { title } : {}) } : {}),
        }),
      }, signal, "Google embedding");
      const values = response.embedding?.values;
      if (!Array.isArray(values) || values.some((value) => typeof value !== "number")) throw new KnowledgeError("INVALID_EMBEDDING", "Google returned an invalid embedding.", 502);
      validateVector(values, binding.embeddingDimensions);
      const norm = Math.hypot(...values);
      return values.map((value) => value / norm);
    },
  };
}
