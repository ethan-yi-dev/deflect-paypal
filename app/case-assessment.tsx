"use client";

import { useState } from "react";
import type { AssessmentSource, CaseAssessmentResult, CitedStatement } from "@/lib/assessment/types";
import { Badge, Icon } from "./workspace-ui";
import styles from "./dispute-workspace.module.css";

function CitationLinks({ ids, prefix }: { ids: string[]; prefix: string }) {
  function openSource(id: string) {
    const source = document.getElementById(`${prefix}-${id}`);
    if (source instanceof HTMLDetailsElement) source.open = true;
    const sources = source?.parentElement;
    if (sources instanceof HTMLDetailsElement) sources.open = true;
  }
  return <span className={styles.assessmentCitations}>{ids.map((id) => <a key={id} href={`#${prefix}-${id}`} onClick={() => openSource(id)} aria-label={`View source ${id}`}>{id}</a>)}</span>;
}
function Statement({ statement, prefix }: { statement: CitedStatement; prefix: string }) {
  return <p>{statement.text}<CitationLinks ids={statement.sourceIds} prefix={prefix} /></p>;
}
function Findings({ title, items, prefix }: { title: string; items: CitedStatement[]; prefix: string }) {
  if (!items.length) return null;
  return <section className={styles.assessmentSection}><h4>{title}</h4><ul>{items.map((item, index) => <li key={index}><Statement statement={item} prefix={prefix} /></li>)}</ul></section>;
}
function Source({ source, prefix }: { source: AssessmentSource; prefix: string }) {
  const label = source.kind === "policy" ? "Policy passage · authority needs review" : source.kind === "evidence" ? "Uploaded evidence" : source.authority.replaceAll("_", " ");
  const sourceUrl = source.documentId ? `/api/knowledge-base/documents/${encodeURIComponent(source.documentId)}/source` : null;
  return <details id={`${prefix}-${source.id}`} className={styles.assessmentSource}>
    <summary><span>{source.id}</span> {source.title}{source.pageNumber ? ` · p. ${source.pageNumber}` : ""}</summary>
    <p className={styles.assessmentSourceLabel}>{label}</p>
    <pre>{source.content}</pre>
    {source.chunkId && <p className={styles.assessmentSourceLabel}>Chunk: {source.chunkId}</p>}
    {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">Open original document<Icon name="arrow" size={12} /></a>}
  </details>;
}

export default function CaseAssessmentView({ result, stale, caseId }: { result: CaseAssessmentResult; stale: boolean; caseId: string }) {
  const [copyNotice, setCopyNotice] = useState("");
  const { assessment } = result;
  const prefix = `assessment-${caseId}`;
  const draft = assessment.recommendation.responseDraft.map((paragraph) => paragraph.text).join("\n\n");
  async function copyDraft() {
    try { await navigator.clipboard.writeText(draft); setCopyNotice("Draft copied. Review it before use."); }
    catch { setCopyNotice("Copy is unavailable. Select and copy the draft text below."); }
  }
  return <div className={styles.assessmentResult}>
    <div className={styles.assessmentMeta}><Badge tone={stale ? "amber" : "green"}>{stale ? "Needs reassessment" : "Ready to review"}</Badge><time dateTime={result.generatedAt}>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Los_Angeles" }).format(new Date(result.generatedAt))}</time></div>
    {stale && <p className={styles.assessmentWarning}>The case or evidence has changed. This result reflects the earlier materials; run the assessment again.</p>}
    {result.warnings.map((warning, index) => <p key={index} className={styles.assessmentWarning}>{warning}</p>)}
    <div className={styles.evidenceAssessment}>
      <h3>Assessment</h3>
      <Statement statement={assessment.summary} prefix={prefix} />
      <section className={styles.assessmentSection}><h4>Buyer&apos;s claim</h4><Statement statement={assessment.buyerClaim} prefix={prefix} /></section>
      <Findings title="Supported facts" items={assessment.supportedFacts} prefix={prefix} />
      <Findings title="Supporting evidence" items={assessment.supportingEvidence} prefix={prefix} />
      <Findings title="Conflicting or unfavorable evidence" items={assessment.conflictingEvidence} prefix={prefix} />
      <Findings title="Applicable policies" items={assessment.applicablePolicies} prefix={prefix} />
      {!assessment.applicablePolicies.length && <p>No retrieved policy was identified as applicable.</p>}
      {!!assessment.missingEvidence.length && <section className={styles.assessmentSection}><h4>Evidence to collect</h4><ul>{[...assessment.missingEvidence].sort((a, b) => ["high", "medium", "low"].indexOf(a.priority) - ["high", "medium", "low"].indexOf(b.priority)).map((item, index) => <li key={index}><div><Badge tone={item.priority === "high" ? "amber" : "neutral"}>{item.priority} priority</Badge><strong className={styles.assessmentChecklistTitle}>{item.item}</strong><p>{item.why}<CitationLinks ids={item.sourceIds} prefix={prefix} /></p></div></li>)}</ul></section>}
      {!!assessment.uncertainties.length && <section className={styles.assessmentSection}><h4>Uncertainties</h4><ul>{assessment.uncertainties.map((item, index) => <li key={index}><p>{item}</p></li>)}</ul></section>}
    </div>
    <section className={styles.assessmentRecommendation}>
      <span className={styles.evidenceActionLabel}>RECOMMENDATION</span><h3>{assessment.recommendation.title}</h3>
      {assessment.recommendation.rationale.map((item, index) => <Statement key={index} statement={item} prefix={prefix} />)}
      {!!assessment.recommendation.reconsiderWhen.length && <details className={styles.assessmentChanges}><summary>What could change this recommendation?</summary><ul>{assessment.recommendation.reconsiderWhen.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
    </section>
    {!!draft && <section className={styles.assessmentDraft}><div className={styles.blockHeading}><span><Icon name="message" size={16} />Response draft</span><button type="button" className={styles.secondaryButton} onClick={copyDraft} disabled={stale}>Copy draft</button></div>{assessment.recommendation.responseDraft.map((item, index) => <Statement key={index} statement={item} prefix={prefix} />)}<p className={styles.evidenceHint}>Review the facts and wording before using this draft.</p>{copyNotice && <p role="status">{copyNotice}</p>}</section>}
    <details className={styles.assessmentSources} open><summary>Sources · {result.sources.length} references</summary>{result.sources.map((source) => <Source key={source.id} source={source} prefix={prefix} />)}</details>
    <details className={styles.assessmentDiagnostics}><summary>Assessment details</summary><p>Model: {result.model}</p><p>Policy passages: {result.retrieval.hitCount} / {result.retrieval.limit} · {result.retrieval.details?.rerankStatus ?? result.retrieval.status}</p><p>Snapshot: {result.snapshotHash}</p><pre>{result.retrieval.query}</pre></details>
    <p className={styles.evidenceHint}>AI-generated guidance for merchant review. No response, evidence or refund has been sent.</p>
  </div>;
}
