"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { DisputeDetail } from "@/lib/disputes";
import { assessEvidence, checkEvidence, EVIDENCE_FILE_ACCEPT, EVIDENCE_GUIDE_URL, evidenceTitle, FILE_GUIDE_URL, getEvidencePlan, validateEvidenceFiles, type EvidenceInput } from "@/lib/dispute-evidence";
import { MAX_ASSESSMENT_FILES, type CaseAssessmentResult } from "@/lib/assessment/types";
import type { EvidenceSubmissionPreview, EvidenceSubmissionResult } from "@/lib/paypal-evidence";
import CaseAssessmentView from "./case-assessment";
import { Badge, Icon } from "./workspace-ui";
import styles from "./dispute-workspace.module.css";

type EvidenceDraft = Omit<EvidenceInput, "files"> & { files: File[] };
export type CaseEvidenceDraft = { inputs: Record<string, EvidenceDraft>; assessment?: CaseAssessmentResult; assessedInputs?: string; assessedCase?: string; submission?: EvidenceSubmissionResult; submittedInputs?: string };
export const EMPTY_CASE_EVIDENCE: CaseEvidenceDraft = { inputs: {} };
const EMPTY_INPUT: EvidenceDraft = { notes: "", carrier: "", trackingNumber: "", refundReference: "", files: [] };

function fileSize(bytes: number) {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.ceil(bytes / 1000)} KB`;
}
function fileKey(file: File) { return `${file.name}-${file.size}-${file.lastModified}`; }
function inputSignature(inputs: Record<string, EvidenceDraft>) {
  return JSON.stringify(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)).map(([type, input]) => ({ type, ...input, files: input.files.map(fileKey) })));
}
function caseSignature(dispute: DisputeDetail) { return JSON.stringify({ ...dispute, raw: undefined }); }
function evidenceForm(inputs: Record<string, EvidenceDraft>) {
  const form = new FormData();
  let fileIndex = 0;
  const groups = Object.entries(inputs).map(([type, input]) => ({ type, notes: input.notes, carrier: input.carrier, trackingNumber: input.trackingNumber, refundReference: input.refundReference,
    fileKeys: input.files.map((file) => { const key = `file-${++fileIndex}`; form.append(key, file); return key; }) }));
  form.set("inputs", JSON.stringify(groups));
  return form;
}

export default function DisputeEvidence({ dispute, draft, onChange, onSubmitted }: { dispute: DisputeDetail; draft: CaseEvidenceDraft; onChange: (draft: CaseEvidenceDraft) => void; onSubmitted: (result: EvidenceSubmissionResult) => void }) {
  const plan = getEvidencePlan(dispute);
  const [fileErrors, setFileErrors] = useState<Record<string, string[]>>({});
  const [assessing, setAssessing] = useState(false);
  const [assessmentError, setAssessmentError] = useState("");
  const [submissionNotice, setSubmissionNotice] = useState("");
  const [submissionError, setSubmissionError] = useState("");
  const [review, setReview] = useState<EvidenceSubmissionPreview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const reviewRequestRef = useRef<AbortController | null>(null);
  const canSubmitEvidence = dispute.canProvideEvidence && dispute.status === "WAITING_FOR_SELLER_RESPONSE";
  const preview = assessEvidence(plan, draft.inputs, canSubmitEvidence);
  const allFiles = Object.values(draft.inputs).flatMap((input) => input.files);
  const stale = !!draft.assessment && (draft.assessedInputs !== inputSignature(draft.inputs) || draft.assessedCase !== caseSignature(dispute) || draft.assessment.caseUpdatedAt !== dispute.updatedAt);
  const draftWasSubmitted = !!draft.submission && draft.submittedInputs === inputSignature(draft.inputs);
  useEffect(() => () => { requestRef.current?.abort(); reviewRequestRef.current?.abort(); }, []);

  function updateInput(type: string, changes: Partial<EvidenceDraft>) {
    if (submitLock.current) return;
    requestRef.current?.abort();
    requestRef.current = null;
    setAssessing(false);
    setAssessmentError("");
    setReview(null);
    reviewRequestRef.current?.abort();
    onChange({ ...draft, inputs: { ...draft.inputs, [type]: { ...(draft.inputs[type] ?? EMPTY_INPUT), ...changes } } });
    setSubmissionNotice("");
  }
  function addFiles(type: string, event: ChangeEvent<HTMLInputElement>) {
    const input = draft.inputs[type] ?? EMPTY_INPUT;
    const knownFiles = new Set(input.files.map(fileKey));
    const candidates = Array.from(event.target.files ?? []).filter((file) => {
      if (knownFiles.has(fileKey(file))) return false;
      knownFiles.add(fileKey(file));
      return true;
    });
    const { accepted, errors } = validateEvidenceFiles(allFiles, candidates);
    if (allFiles.length + accepted.length > MAX_ASSESSMENT_FILES) {
      setFileErrors((previous) => ({ ...previous, [type]: [`Choose at most ${MAX_ASSESSMENT_FILES} files per assessment.`] }));
      event.target.value = "";
      return;
    }
    if (accepted.length) updateInput(type, { files: [...input.files, ...accepted] });
    setFileErrors((previous) => ({ ...previous, [type]: errors }));
    event.target.value = "";
  }
  async function runAssessment() {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setAssessing(true);
    setAssessmentError("");
    setSubmissionNotice("");
    try {
      const response = await fetch(`/api/disputes/${encodeURIComponent(dispute.id)}/assessment`, { method: "POST", body: evidenceForm(draft.inputs), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "Unable to assess the case. Please retry.");
      if (!controller.signal.aborted) onChange({ ...draft, assessment: result as CaseAssessmentResult, assessedInputs: inputSignature(draft.inputs), assessedCase: caseSignature(dispute) });
    } catch (error) {
      if (!controller.signal.aborted) setAssessmentError(error instanceof Error ? error.message : "Unable to read the assessment. Please retry.");
    } finally {
      if (requestRef.current === controller) { requestRef.current = null; setAssessing(false); }
    }
  }

  async function openSubmission() {
    requestRef.current?.abort();
    requestRef.current = null;
    setAssessing(false);
    reviewRequestRef.current?.abort();
    const controller = new AbortController();
    reviewRequestRef.current = controller;
    setReview(null);
    setSubmissionError("");
    setReviewing(true);
    dialogRef.current?.showModal();
    try {
      const response = await fetch(`/api/disputes/${encodeURIComponent(dispute.id)}/evidence`, { method: "POST", headers: { "X-Evidence-Mode": "preview" }, body: evidenceForm(draft.inputs), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "Unable to prepare the evidence submission.");
      if (!controller.signal.aborted) setReview(result as EvidenceSubmissionPreview);
    } catch (error) {
      if (!controller.signal.aborted) setSubmissionError(error instanceof Error ? error.message : "Unable to prepare the evidence submission.");
    } finally { if (reviewRequestRef.current === controller) setReviewing(false); }
  }
  function closeSubmission() {
    if (submitLock.current) return;
    reviewRequestRef.current?.abort();
    dialogRef.current?.close();
  }
  async function confirmSubmission() {
    if (!review || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    setSubmissionError("");
    try {
      const response = await fetch(`/api/disputes/${encodeURIComponent(dispute.id)}/evidence`, { method: "POST", headers: { "X-Evidence-Mode": "submit", "X-Evidence-Review": review.reviewToken }, body: evidenceForm(draft.inputs) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "PayPal evidence submission could not be confirmed. Verify the case before submitting again.");
      const receipt = result as EvidenceSubmissionResult;
      onChange({ ...draft, submission: receipt, submittedInputs: inputSignature(draft.inputs) });
      onSubmitted(receipt);
      setSubmissionNotice(receipt.refreshWarning ?? "PayPal Sandbox accepted your evidence. The case has been refreshed.");
      dialogRef.current?.close();
    } catch (error) {
      setReview(null);
      setSubmissionError(error instanceof Error ? error.message : "The submission result is uncertain. Check the case in PayPal before submitting again.");
    } finally { submitLock.current = false; setSubmitting(false); }
  }

  return <section id="evidence" className={`${styles.panel} ${styles.evidencePanel}`} aria-labelledby="evidence-title">
    <div className={`${styles.panelHeader} ${styles.evidencePanelHeader}`}>
      <div className={styles.evidenceHeading}>
        <span className={styles.evidenceActionIcon}><Icon name="arrow" size={22} /></span>
        <div><span className={styles.evidenceActionLabel}>ACTION WORKSPACE</span><h2 id="evidence-title"><span className={styles.sectionNumber}>03</span>Evidence &amp; next steps</h2><p>Prepare evidence, assess the case, and review the next step.</p></div>
      </div>
      <Badge tone={canSubmitEvidence ? "green" : "neutral"}>{canSubmitEvidence ? "Submission available" : "Submission unavailable"}</Badge>
    </div>
    <div className={styles.panelBody}>
      <div className={styles.evidenceIntroduction}><div><strong>{plan.title}</strong><p>{plan.context}</p><p>{plan.hasSellerRequest ? "Prepare the evidence PayPal has requested from your store below." : "No specific seller request was returned. These are reference options; confirm which evidence applies before submitting."}</p></div><a href={EVIDENCE_GUIDE_URL} target="_blank" rel="noreferrer">PayPal evidence guide<Icon name="arrow" size={13} /></a></div>
      <div className={styles.evidenceWorkspace}>
        <fieldset className={styles.evidenceRules} disabled={submitting} aria-label="Evidence preparation">
          {plan.rules.map((rule) => {
            const input = draft.inputs[rule.type] ?? EMPTY_INPUT;
            const check = checkEvidence(rule, input);
            const prefix = `${dispute.id}-${rule.type}`;
            return <div className={styles.evidenceRule} key={rule.type}>
              <div className={styles.evidenceRuleHeading}><h3>{rule.title}</h3><Badge tone={rule.requested ? "amber" : "neutral"}>{rule.requested ? "Requested by PayPal" : "Reference option"}</Badge></div>
              <p className={styles.evidenceHint}>{rule.hint}</p>
              {(rule.route === "tracking" || rule.route === "tracking-or-document") && <div className={styles.evidenceFields}>
                <label htmlFor={`${prefix}-carrier`}>Carrier<input id={`${prefix}-carrier`} value={input.carrier} maxLength={2000} placeholder="e.g. FedEx" onChange={(event) => updateInput(rule.type, { carrier: event.target.value })} /></label>
                <label htmlFor={`${prefix}-tracking`}>Tracking number<input id={`${prefix}-tracking`} value={input.trackingNumber} maxLength={255} placeholder="Enter shipment tracking" onChange={(event) => updateInput(rule.type, { trackingNumber: event.target.value })} /></label>
              </div>}
              {rule.route === "refund" && <label className={styles.evidenceField} htmlFor={`${prefix}-refund`}>Existing PayPal refund reference<input id={`${prefix}-refund`} value={input.refundReference} maxLength={255} placeholder="Reference of a refund already issued" onChange={(event) => updateInput(rule.type, { refundReference: event.target.value })} /></label>}
              <label className={styles.evidenceField} htmlFor={`${prefix}-notes`}>Evidence note<textarea id={`${prefix}-notes`} value={input.notes} maxLength={2000} rows={3} placeholder="Explain how this evidence responds to the customer's concern." onChange={(event) => updateInput(rule.type, { notes: event.target.value })} /><span className={styles.evidenceCharacterCount}>{input.notes.length} / 2,000</span></label>
              <div className={styles.evidenceUpload}>
                <label htmlFor={`${prefix}-files`}><Icon name="file" size={21} /><strong>Add evidence files</strong><span>JPG, JPEG, GIF, PNG, PDF · each under 10 MB</span></label>
                <input className={styles.evidenceFileInput} id={`${prefix}-files`} type="file" multiple accept={EVIDENCE_FILE_ACCEPT} onChange={(event) => addFiles(rule.type, event)} />
                <p>Used for Deflect analysis. Sent to PayPal only after confirmation.</p>
              </div>
              {(fileErrors[rule.type]?.length ?? 0) > 0 && <ul role="alert" className={styles.evidenceFileErrors}>{fileErrors[rule.type].map((message, index) => <li key={index}>{message}</li>)}</ul>}
              {input.files.length > 0 && <ul className={styles.evidenceFiles} aria-label={`Selected files for ${rule.title}`}>{input.files.map((file) => <li key={fileKey(file)}><Icon name="file" size={16} /><div><strong>{file.name}</strong><span>{fileSize(file.size)} · {draftWasSubmitted ? "Submitted to PayPal" : "Local draft"}</span></div><button type="button" aria-label={`Remove ${file.name}`} onClick={() => { updateInput(rule.type, { files: input.files.filter((item) => item !== file) }); setFileErrors((previous) => ({ ...previous, [rule.type]: [] })); }}><Icon name="close" size={15} /></button></li>)}</ul>}
              <p className={styles.evidenceDraftStatus}><Icon name={check.prepared ? "check" : "alert"} size={14} />{check.prepared ? "Draft prepared · contents need review" : rule.route === "manual" ? "Manual review required" : "Evidence still needed"}</p>
            </div>;
          })}
          {plan.hasSellerRequest && plan.baselineTypes.some((type) => !dispute.requestedEvidence.includes(type)) && <details className={styles.evidenceReference}><summary>Other evidence mentioned in the reason guide</summary><p>{plan.baselineTypes.filter((type) => !dispute.requestedEvidence.includes(type)).map(evidenceTitle).join("; ")}. These are reference options, not additional requests for this case.</p></details>}
        </fieldset>
        <div className={styles.evidenceReview}>
          <div className={styles.blockHeading}><span><Icon name="sparkles" size={16} />Deflect assessment</span><Badge>AI + policy sources</Badge></div>
          <p className={styles.evidenceHint}>Analyze the latest case, your evidence and relevant policies to prepare the next step.</p>
          <div role="status" aria-live="polite">{assessing && <p className={styles.assessmentProgress}><Icon name="refresh" size={16} />Reading the latest case, finding policies and reviewing evidence…</p>}</div>
          {assessmentError && <p role="alert" className={styles.assessmentWarning}>{assessmentError}</p>}
          {draft.assessment ? <CaseAssessmentView key={draft.assessment.generatedAt} result={draft.assessment} stale={stale} caseId={dispute.id} /> : !assessing && <div className={styles.evidenceAssessment}><Icon name="shield" size={30} /><h3>Review the evidence first.</h3><p>Run Deflect assessment to see what the evidence supports, what is missing and what to do next.</p></div>}
          <div className={styles.liveBlockHeading}><span><Icon name="file" size={16} />Files already on PayPal</span></div>
          {dispute.sellerDocuments.length ? <ul className={styles.evidenceFiles}>{dispute.sellerDocuments.map((file, index) => <li key={index}><Icon name="file" size={16} /><div><strong>{file.name}</strong><span>{file.evidenceType ? evidenceTitle(file.evidenceType) : "Seller evidence"} · Submitted to PayPal</span></div></li>)}</ul> : <p className={styles.evidenceHint}>No seller files are listed in the case response.</p>}
        </div>
      </div>
      <div className={styles.evidenceFooter}>
        <p>{allFiles.length} / {MAX_ASSESSMENT_FILES} local files · {fileSize(allFiles.reduce((sum, file) => sum + file.size, 0))} / 50 MB <a href={FILE_GUIDE_URL} target="_blank" rel="noreferrer">File requirements</a><span>Notes and attachments are sent to OpenAI when you run assessment.</span><span>Drafts and assessments stay with each case for this page session. Reloading clears them.</span></p>
        <div className={styles.evidenceActions}>
          <button className={styles.primaryButton} onClick={runAssessment} disabled={assessing || submitting}><Icon name="sparkles" size={16} />{assessing ? "Assessing case…" : draft.assessment ? "Reassess case" : "Run Deflect assessment"}</button>
          {assessing && <button className={styles.secondaryButton} onClick={() => { requestRef.current?.abort(); requestRef.current = null; setAssessing(false); }}>Cancel assessment</button>}
          <button className={styles.secondaryButton} disabled={!canSubmitEvidence || submitting || draftWasSubmitted} onClick={openSubmission}><Icon name="arrow" size={16} />{submitting ? "Submitting evidence…" : draftWasSubmitted ? "Evidence submitted" : "Submit evidence to PayPal"}</button>
        </div>
      </div>
      <p className={styles.supportNote}>Review and confirm before sending evidence to PayPal Sandbox. Evidence submission and a formal appeal are separate actions.</p>
      {submissionNotice && <p className={styles.evidenceSubmissionNotice} role="status">{submissionNotice}</p>}
      {draft.submission && <p className={styles.evidenceSubmissionNotice}>Submission recorded · {draft.submission.submissionId} · {new Date(draft.submission.submittedAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} Pacific time</p>}
    </div>

    <dialog className={styles.dialog} ref={dialogRef} aria-labelledby="evidence-preview-title" onCancel={(event) => { if (submitLock.current) event.preventDefault(); else reviewRequestRef.current?.abort(); }}>
      <div className={styles.dialogHeader}><span className={styles.eyebrow}>PAYPAL SANDBOX SUBMISSION</span><button className={styles.closeButton} disabled={submitting} onClick={closeSubmission} aria-label="Close evidence preview"><Icon name="close" /></button></div>
      <h2 id="evidence-preview-title">Review PayPal evidence</h2>
      <p className={styles.dialogIntro}>Case {dispute.id}. Confirming sends the notes, references and selected files below to PayPal Sandbox.</p>
      {reviewing && <p role="status" className={styles.assessmentProgress}>Checking the latest case and preparing your evidence…</p>}
      {submissionError && <p role="alert" className={styles.assessmentWarning}>{submissionError}</p>}
      {review && <ul className={styles.evidencePreviewList}>{review.evidences.map((item) => <li key={item.type}><strong>{item.title}</strong>{item.carrier && <p>Carrier: {item.carrier}</p>}{item.trackingNumber && <p>Tracking: {item.trackingNumber}</p>}{item.refundReference && <p>Existing refund reference: {item.refundReference}</p>}{item.notes && <p>{item.notes}</p>}{item.documents.map((file) => <p key={file.uploadName}>{file.name} → {file.uploadName} · {fileSize(file.size)}</p>)}</li>)}</ul>}
      <p className={styles.dialogNote}>{review ? "The latest case permits this submission. Check that every statement and document is accurate before confirming." : !reviewing && !submissionError ? preview.suggestion : ""} This submits evidence only. It does not create a refund or accept the buyer&apos;s claim.</p>
      <div className={styles.dialogActions}><button className={styles.secondaryButton} disabled={submitting} onClick={closeSubmission}>Close</button><button className={styles.primaryButton} disabled={!review || reviewing || submitting} onClick={confirmSubmission}>{submitting ? "Submitting to PayPal…" : "Confirm & submit to Sandbox"}</button></div>
    </dialog>
  </section>;
}
