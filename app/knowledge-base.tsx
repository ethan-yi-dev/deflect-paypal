"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { KNOWLEDGE_FILE_ACCEPT, MAX_PDF_BYTES, type ActiveProcessing, type KnowledgeDeleteResult, type KnowledgeDocument, type KnowledgeList, type KnowledgeRetrieval, type KnowledgeSearchResult, type KnowledgeWriteResult, type ModelBinding, type SearchHit } from "@/lib/knowledge/types";
import { Badge, Icon } from "./workspace-ui";
import workspace from "./dispute-workspace.module.css";
import styles from "./knowledge-base.module.css";

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

function processingLabel(progress: ActiveProcessing | null) {
  switch (progress?.stage) {
    case "parse": return "Parsing document…";
    case "chunk": return "Splitting text into chunks…";
    case "embed": return `Embedding chunks ${progress.completedChunks}/${progress.totalChunks}…`;
    case "store": return "Saving chunks and vectors…";
    default: return "Starting processing…";
  }
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
  const [updateTarget, setUpdateTarget] = useState<KnowledgeDocument | null>(null);
  const [inputMode, setInputMode] = useState<"file" | "text">("file");
  const [textName, setTextName] = useState("");
  const [textContent, setTextContent] = useState("");
  const [startingId, setStartingId] = useState("");
  const [activeProcessing, setActiveProcessing] = useState<ActiveProcessing | null>(null);
  const [deletingId, setDeletingId] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [retrieval, setRetrieval] = useState<KnowledgeRetrieval | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const uploadSection = useRef<HTMLElement>(null);
  const dragDepth = useRef(0);
  const removedIds = useRef(new Set<string>());
  const processingRequest = useRef(false);
  const listSequence = useRef(0);
  const processingId = startingId || activeProcessing?.documentId || documents.find((document) => document.status === "running")?.id;
  const processingName = activeProcessing?.documentName || documents.find((document) => document.id === processingId)?.name;

  const reload = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++listSequence.current;
    try {
      const result = await readApi<KnowledgeList>("/api/knowledge-base/documents", { signal });
      if (signal?.aborted || sequence !== listSequence.current) return;
      // A poll started before deletion must not put the removed row back.
      setDocuments(result.documents.filter((document) => !removedIds.current.has(document.id)));
      setActiveProcessing(result.activeProcessing);
      setBinding(result.knowledgeBase);
      setListError("");
      return result;
    } catch (error) {
      if (!signal?.aborted && sequence === listSequence.current) setListError(error instanceof Error ? error.message : "Could not load documents.");
    } finally {
      if (!signal?.aborted && sequence === listSequence.current) setLoading(false);
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
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), processingRequest.current || result?.activeProcessing || result?.documents.some((item) => item.status === "running") ? 2000 : 10000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [hidden, reload, startingId]);

  async function uploadDocuments() {
    setUploading(true);
    setActionError("");
    setNotice("");
    const failures: string[] = [];
    const results: KnowledgeWriteResult[] = [];
    try {
      const endpoint = updateTarget ? `/api/knowledge-base/documents/${updateTarget.id}` : "/api/knowledge-base/documents";
      const headers: Record<string, string> = updateTarget ? { "If-Match": `"${updateTarget.contentHash}"` } : {};
      const method = updateTarget ? "PUT" : "POST";
      if (inputMode === "text") {
        try {
          results.push(await readApi<KnowledgeWriteResult>(endpoint, {
            method, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ name: textName, text: textContent }),
          }));
          setTextContent("");
        } catch (error) { failures.push(error instanceof Error ? error.message : "Could not save text."); }
      } else {
        for (const file of files) {
          try {
            const body = new FormData();
            body.set("file", file);
            results.push(await readApi<KnowledgeWriteResult>(endpoint, { method, headers, body }));
            setFiles((previous) => previous.filter((item) => fileKey(item) !== fileKey(file)));
          } catch (error) { failures.push(`${file.name}: ${error instanceof Error ? error.message : "Upload failed."}`); }
        }
      }
      setActionError(failures.join(" "));
      if (results.length === 1) setNotice(results[0].message);
      else if (results.length) setNotice(`${results.filter((item) => item.changed).length} documents saved as pending. ${results.filter((item) => !item.changed).length} unchanged. Click Process document for each changed document.`);
      if (results.length && updateTarget) setUpdateTarget(null);
      if (results.some((item) => item.changed)) setHits(null);
      await reload();
    } finally { setUploading(false); }
  }

  function beginUpdate(document: KnowledgeDocument) {
    setUpdateTarget(document);
    setInputMode("file");
    setFiles([]);
    setErrors([]);
    setActionError("");
    setNotice("");
    setTextName(document.name.replace(/\.pdf$/i, ".txt"));
    setTextContent("");
    uploadSection.current?.scrollIntoView({ block: "start" });
  }

  function cancelUpdate() {
    setUpdateTarget(null);
    setFiles([]);
    setErrors([]);
    setActionError("");
    setTextName("");
    setTextContent("");
  }

  async function processDocument(document: KnowledgeDocument) {
    if (processingRequest.current || processingId || loading || listError) return;
    processingRequest.current = true;
    ++listSequence.current;
    setStartingId(document.id);
    setActionError("");
    setNotice("");
    setHits(null);
    try {
      const result = await readApi<{ document: KnowledgeDocument }>(`/api/knowledge-base/documents/${document.id}/index`, { method: "POST" });
      ++listSequence.current;
      setDocuments((previous) => previous.map((item) => item.id === document.id ? result.document : item));
      if (result.document.status === "success") setNotice(`${document.name}: processing complete. ${result.document.chunkCount} chunks and their embeddings were saved.`);
      else setActionError(`${document.name}: ${result.document.errorMessage || "Processing failed. Retry processing."}`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not process the document. Refresh to check its status.");
    } finally {
      await reload();
      processingRequest.current = false;
      setStartingId("");
    }
  }

  async function deleteDocument(document: KnowledgeDocument) {
    setDeletingId(document.id);
    setActionError("");
    setNotice("");
    try {
      const result = await readApi<KnowledgeDeleteResult>(`/api/knowledge-base/documents/${document.id}`, { method: "DELETE" });
      removedIds.current.add(document.id);
      setDocuments((previous) => previous.filter((item) => item.id !== document.id));
      setHits((previous) => previous?.filter((hit) => hit.docId !== document.id) ?? null);
      if (updateTarget?.id === document.id) cancelUpdate();
      setNotice(`${document.name}: ${result.message}`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not remove the document.");
    } finally { setDeletingId(""); await reload(); }
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearching(true);
    setSearchError("");
    setHits(null);
    setRetrieval(null);
    try {
      const result = await readApi<KnowledgeSearchResult>("/api/knowledge-base/query", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, embeddingModel: binding?.embeddingModel, limit: 5 }),
      });
      setHits(result.hits.filter((hit) => !removedIds.current.has(hit.docId)));
      setRetrieval(result.retrieval);
    } catch (error) { setSearchError(error instanceof Error ? error.message : "Search failed."); }
    finally { setSearching(false); }
  }

  function addFiles(candidates: File[]) {
    if (uploading) return;
    setActionError("");
    setNotice("");
    if (updateTarget && candidates.length !== 1) { setErrors(["Choose one document when updating."]); return; }
    const accepted: File[] = [];
    const messages: string[] = [];
    const existing = new Set((updateTarget ? [] : files).map(fileKey));

    for (const file of candidates) {
      const extension = `.${file.name.split(".").pop()?.toLowerCase()}`;
      if (!KNOWLEDGE_FILE_ACCEPT.split(",").includes(extension)) {
        messages.push(`${file.name}: choose a PDF, TXT, or MD document.`);
      } else if (file.size === 0 || file.size > MAX_PDF_BYTES) {
        messages.push(`${file.name}: choose a nonempty document up to 50 MB.`);
      } else if (existing.has(fileKey(file))) {
        messages.push(`${file.name} is already selected.`);
      } else {
        accepted.push(file);
        existing.add(fileKey(file));
      }
    }

    setFiles((previous) => updateTarget ? accepted : [...previous, ...accepted]);
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
          <section ref={uploadSection} className={workspace.panel} aria-labelledby="knowledge-upload-title">
            <div className={workspace.panelHeader}>
              <h2 id="knowledge-upload-title"><span className={workspace.sectionNumber}>01</span>{updateTarget ? "Update document" : "Upload documents"}</h2>
              <span className={workspace.smallMuted}>Store policies, guides & reference material</span>
            </div>
            <div className={styles.uploadBody}>
              {updateTarget && <div className={styles.updateBanner}><div><strong>Updating {updateTarget.name}</strong><p>Version {updateTarget.sourceVersion} · Identical content is skipped. Changed content replaces the original and clears its old vectors.</p></div><button type="button" className={workspace.secondaryButton} disabled={uploading} onClick={cancelUpdate}>Cancel update</button></div>}
              <div className={styles.inputModes} aria-label="Document source"><button type="button" aria-pressed={inputMode === "file"} disabled={uploading} onClick={() => setInputMode("file")}><Icon name="upload" size={14} />Upload file</button><button type="button" aria-pressed={inputMode === "text"} disabled={uploading} onClick={() => setInputMode("text")}><Icon name="file" size={14} />Paste text</button></div>
              {inputMode === "file" ? <div
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
                <input ref={fileInput} type="file" multiple={!updateTarget} accept={KNOWLEDGE_FILE_ACCEPT} hidden disabled={uploading} aria-label="Choose knowledge base documents" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
                <span className={styles.fileHint}>PDF, TXT, MD · UTF-8 text · Up to 50 MB per file</span>
              </div> : <div className={styles.textEditor}><label htmlFor="knowledge-text-name">Document name<input id="knowledge-text-name" value={textName} disabled={uploading} maxLength={255} placeholder="shipping-policy.txt" onChange={(event) => setTextName(event.target.value)} /></label><label htmlFor="knowledge-text-content">Document text<textarea id="knowledge-text-content" value={textContent} disabled={uploading} rows={8} placeholder="Paste your policy or support text here…" onChange={(event) => setTextContent(event.target.value)} /></label></div>}

              {errors.length > 0 && <ul className={styles.errors} role="alert">{errors.map((error, index) => <li key={`${error}-${index}`}>{error}</li>)}</ul>}

              {inputMode === "file" && files.length > 0 && <div className={styles.selected}>
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
                <p>{updateTarget ? "Unchanged content keeps its current index. Changes return to pending; click Process document below to rebuild all vectors." : "Documents are saved as pending. Click Process document to parse, split, embed, and save one document at a time."}</p>
                <button type="button" className={workspace.primaryButton} disabled={uploading || !!deletingId || (inputMode === "file" ? !files.length : !textName.trim() || !textContent.trim())} onClick={() => void uploadDocuments()}><Icon name="upload" size={15} />{uploading ? "Saving…" : updateTarget ? "Save update" : inputMode === "text" ? "Save text" : "Upload documents"}</button>
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
            {processingId && <p className={styles.processingNote} role="status"><strong>{processingName || "A document"}</strong>: {processingLabel(activeProcessing)} Other documents can be processed after this one succeeds or fails.</p>}
            {listError && <p className={styles.listError} role="alert">{listError}</p>}
            <div className={styles.tableScroll}>
              <table className={styles.documentsTable}>
                <caption className={styles.srOnly}>Documents stored in your knowledge base</caption>
                <thead><tr><th scope="col">Document name</th><th scope="col">Size</th><th scope="col">Uploaded</th><th scope="col">Status</th><th scope="col">Chunks</th><th scope="col">Action</th></tr></thead>
                <tbody>
                  {documents.length ? documents.map((document) => <tr key={document.id}>
                    <td><a className={styles.documentName} href={`/api/knowledge-base/documents/${document.id}/source`}><Icon name="file" size={17} />{document.name}</a><span className={styles.documentHash} title={`Document ID: ${document.id}\nSHA-256: ${document.contentHash}`}>v{document.sourceVersion} · SHA-256 {document.contentHash?.slice(0, 12)}…</span>{document.errorMessage && <span className={styles.documentError}>{document.errorMessage}</span>}</td>
                    <td>{fileSize(document.size)}</td>
                    <td><time dateTime={document.uploadedAt}>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "America/Los_Angeles" }).format(new Date(document.uploadedAt))}</time></td>
                    <td><Badge tone={document.status === "running" || startingId === document.id ? "amber" : document.status === "success" ? "green" : document.status === "failed" ? "red" : "neutral"}>{startingId === document.id ? "running" : document.status}</Badge>{activeProcessing?.documentId === document.id && <span className={styles.processingStage}>{processingLabel(activeProcessing)}</span>}</td>
                    <td>{document.status === "success" && startingId !== document.id ? document.chunkCount : "—"}</td>
                    <td><div className={styles.rowActions}><button type="button" className={`${workspace.secondaryButton} ${styles.indexButton}`} disabled={!!processingId || !!deletingId || uploading} onClick={() => beginUpdate(document)}>Update</button><button type="button" className={`${workspace.secondaryButton} ${styles.indexButton}`} disabled={!!processingId || loading || !!listError || !!deletingId || uploading || updateTarget?.id === document.id} title={processingId && processingId !== document.id ? "Wait for the current document to succeed or fail." : "Parse, split into chunks, generate embeddings, and save this document."} onClick={() => void processDocument(document)}>{processingId === document.id ? "Processing…" : document.status === "failed" ? "Retry processing" : document.status === "success" ? "Reprocess" : "Process document"}</button><button type="button" className={`${workspace.secondaryButton} ${styles.deleteButton}`} disabled={!!deletingId || !!processingId || uploading} title="Exclude this document and its chunks from search; keep the stored source and vectors" aria-label={`Delete ${document.name} from knowledge base`} onClick={() => void deleteDocument(document)}>{deletingId === document.id ? "Removing…" : "Delete"}</button></div></td>
                  </tr>) : <tr><td colSpan={6}>
                    <div className={styles.emptyState}><span><Icon name="book" size={28} /></span><h3>{loading ? "Loading documents…" : listError ? "Documents are unavailable" : "No uploaded documents yet"}</h3><p>{listError ? "Check the connection message above, then refresh." : "Upload a document or paste text above to add it to your knowledge base."}</p></div>
                  </td></tr>}
                </tbody>
              </table>
            </div>
            <p className={styles.deleteHint}>Delete removes a document and its chunks from search. The original content and vectors stay stored.</p>
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
              {hits && retrieval?.rerankStatus === "applied" && <p className={styles.searchHint}>Reranked {retrieval.candidateCount} candidates with {retrieval.rerankerModel}.</p>}
              {hits && retrieval?.warning && <p className={styles.searchWarning} role="status">{retrieval.warning}</p>}
              {hits && <ul className={styles.searchResults}>{hits.map((hit) => <li key={hit.id}><div><strong>{hit.documentName}</strong><span>Page {hit.pageNumber} · {hit.rerankScore !== undefined && <>Rerank {hit.rerankScore.toFixed(3)} · </>}Similarity {hit.score.toFixed(3)}</span></div><p>{hit.content}</p></li>)}</ul>}
            </div>
          </section>
        </div>
        <footer className={workspace.footer}><span><Icon name="shield" size={13} />Better context. More considered decisions.</span><span>Deflect <span className={workspace.footerDot}>·</span>Knowledge base</span></footer>
      </div>
    </main>
  );
}
