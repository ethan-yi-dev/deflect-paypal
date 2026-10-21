"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { Badge, Icon } from "./workspace-ui";
import workspace from "./dispute-workspace.module.css";
import styles from "./knowledge-base.module.css";

const fileAccept = ".pdf,.doc,.docx,.txt,.md";
const maxFileBytes = 20 * 1024 * 1024;

// Populate this list from the knowledge-base API once storage is connected.
export type KnowledgeDocument = {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
  status: "processing" | "ready" | "failed";
};

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

export default function KnowledgeBase({ hidden, onBack, documents = [] }: {
  hidden: boolean;
  onBack: () => void;
  documents?: KnowledgeDocument[];
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    if (!hidden) heading.current?.focus();
  }, [hidden]);

  function addFiles(candidates: File[]) {
    const accepted: File[] = [];
    const messages: string[] = [];
    const existing = new Set(files.map(fileKey));

    for (const file of candidates) {
      const extension = `.${file.name.split(".").pop()?.toLowerCase()}`;
      if (!fileAccept.split(",").includes(extension)) {
        messages.push(`${file.name}: choose a PDF, DOC, DOCX, TXT, or MD document.`);
      } else if (file.size === 0 || file.size > maxFileBytes) {
        messages.push(`${file.name}: choose a nonempty document up to 20 MB.`);
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
                <button type="button" className={workspace.primaryButton} onClick={() => fileInput.current?.click()}><Icon name="upload" size={15} />Choose files</button>
                <input ref={fileInput} type="file" multiple accept={fileAccept} hidden aria-label="Choose knowledge base documents" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
                <span className={styles.fileHint}>PDF, DOC, DOCX, TXT, MD · Up to 20 MB per file</span>
              </div>

              {errors.length > 0 && <ul className={styles.errors} role="alert">{errors.map((error, index) => <li key={`${error}-${index}`}>{error}</li>)}</ul>}

              {files.length > 0 && <div className={styles.selected}>
                <div className={styles.selectedHeading}><h3>Selected documents <span>{files.length}</span></h3><button type="button" onClick={() => { setFiles([]); setErrors([]); }}>Clear all</button></div>
                <ul className={styles.fileList} aria-label="Documents selected for upload">
                  {files.map((file) => <li key={fileKey(file)}>
                    <span className={styles.fileIcon}><Icon name="file" size={20} /></span>
                    <div><strong>{file.name}</strong><span>{fileSize(file.size)} · Not uploaded</span></div>
                    <button type="button" className={workspace.closeButton} aria-label={`Remove ${file.name}`} onClick={() => setFiles((previous) => previous.filter((item) => fileKey(item) !== fileKey(file)))}><Icon name="close" size={16} /></button>
                  </li>)}
                </ul>
              </div>}

              <div className={styles.uploadFooter}>
                <p role="status">{files.length ? `${files.length} document${files.length === 1 ? "" : "s"} selected locally. ` : ""}Upload is not connected yet. Selected files stay here until you reload.</p>
                <button type="button" className={workspace.primaryButton} disabled title="Document storage is not connected yet"><Icon name="upload" size={15} />Upload documents</button>
              </div>
            </div>
          </section>

          <section className={workspace.panel} aria-labelledby="knowledge-documents-title">
            <div className={workspace.panelHeader}>
              <h2 id="knowledge-documents-title"><span className={workspace.sectionNumber}>02</span>Uploaded documents</h2>
              <Badge>{documents.length} document{documents.length === 1 ? "" : "s"}</Badge>
            </div>
            <div className={styles.tableScroll}>
              <table className={styles.documentsTable}>
                <caption className={styles.srOnly}>Documents stored in your knowledge base</caption>
                <thead><tr><th scope="col">Document name</th><th scope="col">Size</th><th scope="col">Uploaded</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {documents.length ? documents.map((document) => <tr key={document.id}>
                    <td><span className={styles.documentName}><Icon name="file" size={17} />{document.name}</span></td>
                    <td>{fileSize(document.size)}</td>
                    <td><time dateTime={document.uploadedAt}>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "America/Los_Angeles" }).format(new Date(document.uploadedAt))}</time></td>
                    <td><Badge tone={document.status === "ready" ? "green" : document.status === "failed" ? "red" : "amber"}>{document.status === "ready" ? "Ready" : document.status === "failed" ? "Failed" : "Processing"}</Badge></td>
                  </tr>) : <tr><td colSpan={4}>
                    <div className={styles.emptyState}><span><Icon name="book" size={28} /></span><h3>No uploaded documents yet</h3><p>Documents saved to your knowledge base will appear here.</p><span className={styles.emptyNote}>Document storage is not connected yet.</span></div>
                  </td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <footer className={workspace.footer}><span><Icon name="shield" size={13} />Better context. More considered decisions.</span><span>Deflect <span className={workspace.footerDot}>·</span>Knowledge base</span></footer>
      </div>
    </main>
  );
}
