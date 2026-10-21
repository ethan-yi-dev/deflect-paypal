"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { MAX_PDF_BYTES, type KnowledgeDocument, type KnowledgeList, type ModelBinding, type SearchHit } from "@/lib/knowledge/types";
import { Badge, Icon } from "./workspace-ui";
import workspace from "./dispute-workspace.module.css";
import styles from "./knowledge-base.module.css";

const fileAccept = ".pdf";

async function readApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || "The knowledge request failed. Please try again.");
  if (!payload) throw new Error("Unable to read the knowledge response.");
  return payload as T;
}

function fileSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function fileKey(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

export function KnowledgeBaseButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={workspace.knowledgeButton} aria-pressed={active} aria-controls="knowledge-base-workspace" onClick={onClick}>
      <Icon name="book" size={20} />
      <span>Customize Your own knowledge base</span>
      <Icon name="chevron" size={14} />
    </button>
  );
}

export default function KnowledgeBase({ hidden, onBack }: {
  hidden: boolean;
  onBack: () => void;
}) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [binding, setBinding] = useState<ModelBinding | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [uploading, setUploading] = useState(false);
  const [startingId, setStartingId] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const dragDepth = useRef(0);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await readApi<KnowledgeList>("/api/knowledge-base/documents", { signal });
      if (signal?.aborted) return;
      setDocuments(result.documents);
      setBinding(result.knowledgeBase);
      setListError("");
      return result;
    } catch (error) {
      if (!signal?.aborted) setListError(error instanceof Error ? error.message : "Could not load documents.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hidden) heading.current?.focus();
  }, [hidden]);

  useEffect(() => {
    if (hidden) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const result = await reload(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), result?.documents.some((item) => item.status === "running") ? 2000 : 10000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [hidden, reload]);

  async function uploadDocuments() {
    setUploading(true);
    setActionError("");
    setNotice("");
    const failures: string[] = [];
    let count = 0;
    try {
      for (const file of files) {
        try {
          const body = new FormData();
          body.set("file", file);
          await readApi("/api/knowledge-base/documents", { method: "POST", body });
          count += 1;
          setFiles((previous) => previous.filter((item) => fileKey(item) !== fileKey(file)));
        } catch (error) { failures.push(`${file.name}: ${error instanceof Error ? error.message : "Upload failed."}`); }
      }
      setActionError(failures.join(" "));
      if (count) setNotice(`${count} PDF${count === 1 ? "" : "s"} uploaded as pending. Start chunking when you are ready.`);
      await reload();
    } finally { setUploading(false); }
  }

  async function startIndexing(document: KnowledgeDocument) {
    setStartingId(document.id);
    setActionError("");
    setNotice("");
    setHits(null);
    try {
      const result = await readApi<{ document: KnowledgeDocument }>(`/api/knowledge-base/documents/${document.id}/index`, { method: "POST" });
      setDocuments((previous) => previous.map((item) => item.id === document.id ? result.document : item));
      setNotice(`Indexing queued for ${document.name}. Status updates automatically while this page is open.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not start indexing.");
    } finally { setStartingId(""); await reload(); }
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearching(true);
    setSearchError("");
    setHits(null);
    try {
      const result = await readApi<{ hits: SearchHit[] }>("/api/knowledge-base/query", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, embeddingModel: binding?.embeddingModel, limit: 5 }),
      });
      setHits(result.hits);
    } catch (error) { setSearchError(error instanceof Error ? error.message : "Search failed."); }
    finally { setSearching(false); }
  }

  function addFiles(candidates: File[]) {
    if (uploading) return;
    setActionError("");
    setNotice("");
    const accepted: File[] = [];
    const messages: string[] = [];
    const existing = new Set(files.map(fileKey));

    for (const file of candidates) {
      const extension = `.${file.name.split(".").pop()?.toLowerCase()}`;
      if (extension !== ".pdf") {
        messages.push(`${file.name}: choose a PDF document.`);
      } else if (file.size === 0 || file.size > MAX_PDF_BYTES) {
        messages.push(`${file.name}: choose a nonempty PDF up to 50 MB.`);
      } else if (existing.has(fileKey(file))) {
        messages.push(`${file.name} is already selected.`);
      } else {
        accepted.push(file);
        existing.add(fileKey(file));
      }
    }

    setFiles((previous) => [...previous, ...accepted]);
    setErrors(messages);
  }

  function dropFiles(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <main id="knowledge-base-workspace" className={workspace.main} hidden={hidden}>
      <header className={workspace.topbar}>
        <div className={workspace.breadcrumb}>Workspace<Icon name="chevron" size={13} /><span>Knowledge base</span></div>
        <button type="button" className={workspace.sourceSwitch} onClick={onBack}>Back to disputes<Icon name="arrow" size={14} /></button>
      </header>
      <div className={workspace.content}>
        <div className={workspace.pageHeading}>
          <div>
            <div className={workspace.eyebrow}>YOUR POLICIES. YOUR CONTEXT.</div>
            <h1 ref={heading} tabIndex={-1} className={styles.heading}>Your knowledge base<span>.</span></h1>
            <p>Bring your store policies and support documents together.</p>
          </div>
          <span className={workspace.modePill}><Icon name="book" size={14} />Custom knowledge</span>
        </div>

        <div className={styles.sections}>
          <section className={workspace.panel} aria-labelledby="knowledge-upload-title">
            <div className={workspace.panelHeader}>
              <h2 id="knowledge-upload-title"><span className={workspace.sectionNumber}>01</span>Upload documents</h2>
              <span className={workspace.smallMuted}>Store policies, guides & reference material</span>
            </div>
            <div className={styles.uploadBody}>
              <div
                className={`${styles.dropzone} ${dragging ? styles.dragging : ""}`}
                onDragEnter={(event) => { event.preventDefault(); dragDepth.current += 1; setDragging(true); }}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
                onDragLeave={(event) => { event.preventDefault(); dragDepth.current -= 1; if (dragDepth.current === 0) setDragging(false); }}
                onDrop={dropFiles}
              >
                <span className={styles.uploadIcon}><Icon name="upload" size={27} /></span>
                <h3>{dragging ? "Drop your documents here" : "A home for your store’s knowledge"}</h3>
                <p>Drag and drop documents here, or choose files to get started.</p>
                <button type="button" className={workspace.primaryButton} disabled={uploading} onClick={() => fileInput.current?.click()}><Icon name="upload" size={15} />Choose files</button>
                <input ref={fileInput} type="file" multiple accept={fileAccept} hidden disabled={uploading} aria-label="Choose knowledge base documents" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
                <span className={styles.fileHint}>PDF · Up to 50 MB per file</span>
              </div>

              {errors.length > 0 && <ul className={styles.errors} role="alert">{errors.map((error, index) => <li key={`${error}-${index}`}>{error}</li>)}</ul>}

              {files.length > 0 && <div className={styles.selected}>
                <div className={styles.selectedHeading}><h3>Selected documents <span>{files.length}</span></h3><button type="button" disabled={uploading} onClick={() => { setFiles([]); setErrors([]); setActionError(""); }}>Clear all</button></div>
                <ul className={styles.fileList} aria-label="Documents selected for upload">
                  {files.map((file) => <li key={fileKey(file)}>
                    <span className={styles.fileIcon}><Icon name="file" size={20} /></span>
                    <div><strong>{file.name}</strong><span>{fileSize(file.size)} · Not uploaded</span></div>
                    <button type="button" className={workspace.closeButton} disabled={uploading} aria-label={`Remove ${file.name}`} onClick={() => setFiles((previous) => previous.filter((item) => fileKey(item) !== fileKey(file)))}><Icon name="close" size={16} /></button>
                  </li>)}
                </ul>
              </div>}

              <div className={styles.uploadFooter}>
                <p>PDFs are saved to your knowledge base as pending. Start chunking below to make them searchable.</p>
                <button type="button" className={workspace.primaryButton} disabled={!files.length || uploading} onClick={() => void uploadDocuments()}><Icon name="upload" size={15} />{uploading ? "Uploading…" : "Upload documents"}</button>
              </div>
              {actionError && <p className={styles.errors} role="alert">{actionError}</p>}
              {notice && <p className={styles.notice} role="status">{notice}</p>}
            </div>
          </section>

          <section className={workspace.panel} aria-labelledby="knowledge-documents-title" aria-busy={loading}>
            <div className={workspace.panelHeader}>
              <h2 id="knowledge-documents-title"><span className={workspace.sectionNumber}>02</span>Uploaded documents</h2>
              <div className={styles.documentControls}><Badge>{documents.length} document{documents.length === 1 ? "" : "s"}</Badge><button type="button" className={workspace.refreshButton} disabled={loading} aria-label="Refresh knowledge documents" onClick={() => { setLoading(true); void reload(); }}><Icon name="refresh" size={14} /></button></div>
            </div>
            {binding && <p className={styles.modelNote}>Embedding model: <strong>{binding.embeddingModel}</strong> · {binding.embeddingDimensions} dimensions · Bound to this knowledge base</p>}
            {listError && <p className={styles.listError} role="alert">{listError}</p>}
            <div className={styles.tableScroll}>
              <table className={styles.documentsTable}>
                <caption className={styles.srOnly}>Documents stored in your knowledge base</caption>
                <thead><tr><th scope="col">Document name</th><th scope="col">Size</th><th scope="col">Uploaded</th><th scope="col">Status</th><th scope="col">Chunks</th><th scope="col">Action</th></tr></thead>
                <tbody>
                  {documents.length ? documents.map((document) => <tr key={document.id}>
                    <td><a className={styles.documentName} href={`/api/knowledge-base/documents/${document.id}/pdf`}><Icon name="file" size={17} />{document.name}</a>{document.errorMessage && <span className={styles.documentError}>{document.errorMessage}</span>}</td>
                    <td>{fileSize(document.size)}</td>
                    <td><time dateTime={document.uploadedAt}>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "America/Los_Angeles" }).format(new Date(document.uploadedAt))}</time></td>
                    <td><Badge tone={document.status === "success" ? "green" : document.status === "failed" ? "red" : document.status === "running" ? "amber" : "neutral"}>{document.status}</Badge></td>
                    <td>{document.status === "success" ? document.chunkCount : "—"}</td>
                    <td><button type="button" className={`${workspace.secondaryButton} ${styles.indexButton}`} disabled={document.status === "running" || !!startingId} onClick={() => void startIndexing(document)}>{document.status === "running" || startingId === document.id ? "Running…" : document.status === "failed" ? "Retry chunking" : document.status === "success" ? "Reindex" : "Start chunking"}</button></td>
                  </tr>) : <tr><td colSpan={6}>
                    <div className={styles.emptyState}><span><Icon name="book" size={28} /></span><h3>{loading ? "Loading documents…" : listError ? "Documents are unavailable" : "No uploaded documents yet"}</h3><p>{listError ? "Check the connection message above, then refresh." : "Upload a PDF above to add it to your knowledge base."}</p></div>
                  </td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className={workspace.panel} aria-labelledby="knowledge-search-title">
            <div className={workspace.panelHeader}><h2 id="knowledge-search-title"><span className={workspace.sectionNumber}>03</span>Search your knowledge</h2><Badge>Indexed documents</Badge></div>
            <div className={styles.searchBody}>
              <form className={styles.searchForm} onSubmit={(event) => void search(event)}>
                <label className={styles.srOnly} htmlFor="knowledge-query">Search query</label>
                <input id="knowledge-query" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={2000} required placeholder="Ask about your store policies…" />
                <button type="submit" className={workspace.primaryButton} disabled={searching || !query.trim() || !documents.some((item) => item.status === "success")}>{searching ? "Searching…" : "Search"}<Icon name="arrow" size={15} /></button>
              </form>
              <p className={styles.searchHint}>Search is available after a document reaches success.</p>
              {searchError && <p className={styles.errors} role="alert">{searchError}</p>}
              <div role="status" aria-live="polite">{hits && <p className={styles.searchHint}>{hits.length} matching chunk{hits.length === 1 ? "" : "s"} found.</p>}</div>
              {hits && <ul className={styles.searchResults}>{hits.map((hit) => <li key={hit.id}><div><strong>{hit.documentName}</strong><span>Page {hit.pageNumber} · Similarity {hit.score.toFixed(3)}</span></div><p>{hit.content}</p></li>)}</ul>}
            </div>
          </section>
        </div>
        <footer className={workspace.footer}><span><Icon name="shield" size={13} />Better context. More considered decisions.</span><span>Deflect <span className={workspace.footerDot}>·</span>Knowledge base</span></footer>
      </div>
    </main>
  );
}
