"use client";

import { useRef, useState, type ChangeEvent } from "react";
import type { DisputeDetail } from "@/lib/disputes";
import { assessEvidence, checkEvidence, EVIDENCE_FILE_ACCEPT, EVIDENCE_GUIDE_URL, evidenceTitle, FILE_GUIDE_URL, getEvidencePlan, validateEvidenceFiles, type EvidenceAssessment, type EvidenceInput } from "@/lib/dispute-evidence";
import { Badge, Icon } from "./workspace-ui";
import styles from "./dispute-workspace.module.css";

type EvidenceDraft = Omit<EvidenceInput, "files"> & { files: File[] };
export type CaseEvidenceDraft = { inputs: Record<string, EvidenceDraft> };
export const EMPTY_CASE_EVIDENCE: CaseEvidenceDraft = { inputs: {} };
const EMPTY_INPUT: EvidenceDraft = { notes: "", carrier: "", trackingNumber: "", refundReference: "", files: [] };

function fileSize(bytes: number) {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.ceil(bytes / 1000)} KB`;
}
function fileKey(file: File) { return `${file.name}-${file.size}-${file.lastModified}`; }

export default function DisputeEvidence({ dispute, draft, onChange }: { dispute: DisputeDetail; draft: CaseEvidenceDraft; onChange: (draft: CaseEvidenceDraft) => void }) {
  const plan = getEvidencePlan(dispute);
  const [fileErrors, setFileErrors] = useState<Record<string, string[]>>({});
  const [assessment, setAssessment] = useState<EvidenceAssessment | null>(null);
  const [submissionNotice, setSubmissionNotice] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const preview = assessEvidence(plan, draft.inputs, dispute.canProvideEvidence);
  const allFiles = Object.values(draft.inputs).flatMap((input) => input.files);

  function updateInput(type: string, changes: Partial<EvidenceDraft>) {
    onChange({ inputs: { ...draft.inputs, [type]: { ...(draft.inputs[type] ?? EMPTY_INPUT), ...changes } } });
    setAssessment(null);
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
    if (accepted.length) updateInput(type, { files: [...input.files, ...accepted] });
    setFileErrors((previous) => ({ ...previous, [type]: errors }));
    event.target.value = "";
  }
  function runAssessment() {
    setAssessment(assessEvidence(plan, draft.inputs, dispute.canProvideEvidence));
    setSubmissionNotice("");
  }

  return <section id="evidence" className={`${styles.panel} ${styles.evidencePanel}`} aria-labelledby="evidence-title">
    <div className={`${styles.panelHeader} ${styles.evidencePanelHeader}`}>
      <div className={styles.evidenceHeading}>
        <span className={styles.evidenceActionIcon}><Icon name="arrow" size={22} /></span>
        <div><span className={styles.evidenceActionLabel}>ACTION WORKSPACE</span><h2 id="evidence-title"><span className={styles.sectionNumber}>03</span>Evidence &amp; next steps</h2><p>Prepare evidence, assess the case, and review the next step.</p></div>
      </div>
      <Badge tone={dispute.canProvideEvidence ? "green" : "neutral"}>{dispute.canProvideEvidence ? "Submission available" : "Submission unavailable"}</Badge>
    </div>
    <div className={styles.panelBody}>
      <div className={styles.evidenceIntroduction}><div><strong>{plan.title}</strong><p>{plan.context}</p><p>{plan.hasSellerRequest ? "Prepare the evidence PayPal has requested from your store below." : "No specific seller request was returned. These are reference options; confirm which evidence applies before submitting."}</p></div><a href={EVIDENCE_GUIDE_URL} target="_blank" rel="noreferrer">PayPal evidence guide<Icon name="arrow" size={13} /></a></div>
      <div className={styles.evidenceWorkspace}>
        <div className={styles.evidenceRules}>
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
              {dispute.canProvideEvidence ? <div className={styles.evidenceUpload}>
                <label htmlFor={`${prefix}-files`}><Icon name="file" size={21} /><strong>Add evidence files</strong><span>JPG, JPEG, GIF, PNG, PDF · each under 10 MB</span></label>
                <input className={styles.evidenceFileInput} id={`${prefix}-files`} type="file" multiple accept={EVIDENCE_FILE_ACCEPT} onChange={(event) => addFiles(rule.type, event)} />
                <p>Selected locally. Files are not uploaded to PayPal yet.</p>
              </div> : <p className={styles.evidenceUnavailable}>PayPal has not made evidence submission available for this case. File selection is unavailable.</p>}
              {(fileErrors[rule.type]?.length ?? 0) > 0 && <ul role="alert" className={styles.evidenceFileErrors}>{fileErrors[rule.type].map((message, index) => <li key={index}>{message}</li>)}</ul>}
              {input.files.length > 0 && <ul className={styles.evidenceFiles} aria-label={`Selected files for ${rule.title}`}>{input.files.map((file) => <li key={fileKey(file)}><Icon name="file" size={16} /><div><strong>{file.name}</strong><span>{fileSize(file.size)} · Not uploaded</span></div><button type="button" aria-label={`Remove ${file.name}`} onClick={() => { updateInput(rule.type, { files: input.files.filter((item) => item !== file) }); setFileErrors((previous) => ({ ...previous, [rule.type]: [] })); }}><Icon name="close" size={15} /></button></li>)}</ul>}
              <p className={styles.evidenceDraftStatus}><Icon name={check.prepared ? "check" : "alert"} size={14} />{check.prepared ? "Draft prepared · contents need review" : rule.route === "manual" ? "Manual review required" : "Evidence still needed"}</p>
            </div>;
          })}
          {plan.hasSellerRequest && plan.baselineTypes.some((type) => !dispute.requestedEvidence.includes(type)) && <details className={styles.evidenceReference}><summary>Other evidence mentioned in the reason guide</summary><p>{plan.baselineTypes.filter((type) => !dispute.requestedEvidence.includes(type)).map(evidenceTitle).join("; ")}. These are reference options, not additional requests for this case.</p></details>}
        </div>
        <div className={styles.evidenceReview}>
          <div className={styles.blockHeading}><span><Icon name="sparkles" size={16} />Deflect assessment</span><Badge>Basic rules</Badge></div>
          <p className={styles.evidenceHint}>Check the draft against PayPal&apos;s baseline rules. The LLM recommendation is not connected yet.</p>
          <div className={styles.evidenceAssessment} role="status" aria-live="polite">
            {assessment ? <><h3>{assessment.title}</h3><p>{assessment.suggestion}</p><ul>{assessment.checks.map((check) => <li key={check.type}><Icon name={check.prepared ? "check" : "alert"} size={16} /><div><strong>{check.title}</strong>{check.prepared ? <p>Draft prepared. Check the actual contents before submitting.</p> : check.missing.map((item) => <p key={item}>{item}</p>)}</div></li>)}</ul></> : <><Icon name="shield" size={30} /><h3>Review the evidence first.</h3><p>Run Deflect assessment to see what is missing and what to do next.</p></>}
          </div>
          <div className={styles.liveBlockHeading}><span><Icon name="file" size={16} />Files already on PayPal</span></div>
          {dispute.sellerDocuments.length ? <ul className={styles.evidenceFiles}>{dispute.sellerDocuments.map((file, index) => <li key={index}><Icon name="file" size={16} /><div><strong>{file.name}</strong><span>{file.evidenceType ? evidenceTitle(file.evidenceType) : "Seller evidence"} · Submitted to PayPal</span></div></li>)}</ul> : <p className={styles.evidenceHint}>No seller files are listed in the case response.</p>}
        </div>
      </div>
      <div className={styles.evidenceFooter}>
        <p>{allFiles.length} local file{allFiles.length === 1 ? "" : "s"} · {fileSize(allFiles.reduce((sum, file) => sum + file.size, 0))} / 50 MB <a href={FILE_GUIDE_URL} target="_blank" rel="noreferrer">File requirements</a><span>Drafts stay with each case for this page session. Reloading clears them.</span></p>
        <div className={styles.evidenceActions}>
          <button className={styles.primaryButton} onClick={runAssessment}><Icon name="sparkles" size={16} />Run Deflect assessment</button>
          <button className={styles.secondaryButton} disabled={!dispute.canProvideEvidence} onClick={() => { setSubmissionNotice(""); dialogRef.current?.showModal(); }}><Icon name="arrow" size={16} />Submit evidence to PayPal</button>
        </div>
      </div>
      <p className={styles.supportNote}>PayPal submission currently opens a preview. Evidence submission and a formal appeal are separate actions.</p>
      {submissionNotice && <p className={styles.evidenceSubmissionNotice} role="status">{submissionNotice}</p>}
    </div>

    <dialog className={styles.dialog} ref={dialogRef} aria-labelledby="evidence-preview-title">
      <div className={styles.dialogHeader}><span className={styles.eyebrow}>SUBMISSION PREVIEW</span><button className={styles.closeButton} onClick={() => dialogRef.current?.close()} aria-label="Close evidence preview"><Icon name="close" /></button></div>
      <h2 id="evidence-preview-title">Review PayPal evidence</h2>
      <p className={styles.dialogIntro}>Case {dispute.id}. PayPal submission is not connected; this preview sends no files.</p>
      <ul className={styles.evidencePreviewList}>{plan.rules.map((rule) => {
        const input = draft.inputs[rule.type] ?? EMPTY_INPUT;
        return <li key={rule.type}><strong>{rule.title}</strong>{input.carrier && <p>Carrier: {input.carrier}</p>}{input.trackingNumber && <p>Tracking: {input.trackingNumber}</p>}{input.refundReference && <p>Refund reference: {input.refundReference}</p>}{input.notes && <p>{input.notes}</p>}{input.files.map((file) => <p key={fileKey(file)}>{file.name} · {fileSize(file.size)}</p>)}{!input.notes && !input.files.length && !input.carrier && !input.trackingNumber && !input.refundReference && <p>No evidence prepared.</p>}</li>;
      })}</ul>
      <p className={styles.dialogNote}>{preview.canPreviewSubmission ? "Required draft fields are present. The evidence contents still need your review." : preview.suggestion}{!preview.canPreviewSubmission && preview.checks.flatMap((check) => check.missing).map((item) => <span className={styles.evidenceMissingItem} key={item}>{item}</span>)}</p>
      <div className={styles.dialogActions}><button className={styles.secondaryButton} onClick={() => dialogRef.current?.close()}>Close</button><button className={styles.primaryButton} disabled={!preview.canPreviewSubmission} onClick={() => { dialogRef.current?.close(); setSubmissionNotice("Preview complete. PayPal submission is not connected; no evidence was sent."); }}>Confirm preview</button></div>
    </dialog>
  </section>;
}
