"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { DisputeDetailResult, DisputeListResult, DisputeSummary, Money } from "@/lib/disputes";
import { Badge, Fact, Icon } from "./workspace-ui";
import DisputeEvidence, { EMPTY_CASE_EVIDENCE, type CaseEvidenceDraft } from "./dispute-evidence";
import styles from "./dispute-workspace.module.css";

const timeZone = "America/Los_Angeles";
const labels: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Item not as described",
  UNAUTHORISED: "Unauthorized purchase",
  CREDIT_NOT_PROCESSED: "Refund not received",
  DUPLICATE_TRANSACTION: "Duplicate charge",
  INCORRECT_AMOUNT: "Incorrect charge amount",
  PAYMENT_BY_OTHER_MEANS: "Paid another way",
  CANCELED_RECURRING_BILLING: "Charged after cancellation",
  WAITING_FOR_SELLER_RESPONSE: "Awaiting seller response",
  WAITING_FOR_BUYER_RESPONSE: "Awaiting buyer response",
  UNDER_REVIEW: "Under review",
  HELD: "Funds held",
  PROOF_OF_FULFILLMENT: "Proof of fulfillment",
  PROOF_OF_REFUND: "Proof of refund",
  BUYER: "Buyer",
  SELLER: "Seller",
  PAYPAL: "PayPal",
  UNKNOWN: "Unknown sender",
};
const responseGuidance: Record<string, { title: string; description: string }> = {
  WAITING_FOR_SELLER_RESPONSE: { title: "Your response is needed.", description: "Review the customer's concern and the requested evidence before the response deadline." },
  WAITING_FOR_BUYER_RESPONSE: { title: "Waiting for the customer.", description: "The next response is due from the buyer. Review the conversation for their latest request." },
  UNDER_REVIEW: { title: "PayPal is reviewing the case.", description: "Check the latest messages and any requests for additional evidence." },
  RESOLVED: { title: "This case is resolved.", description: "Review the conversation and case dates for context when following up with the customer." },
};

function label(value: string | null | undefined): string {
  if (!value) return "Not provided";
  return labels[value] ?? value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}
function money(value: Money | null | undefined): string {
  return value ? `${value.value} ${value.currency}` : "Not provided";
}
function date(value: string | null | undefined, kind: "date" | "time" | "full" = "full"): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not provided";
  const options: Intl.DateTimeFormatOptions = kind === "date"
    ? { month: "short", day: "numeric", year: "numeric" }
    : kind === "time"
      ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" }
      : { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(new Date(value));
}
function initials(name: string | null | undefined): string {
  return name?.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "—";
}
async function readApi<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store" });
  let result;
  try { result = await response.json(); }
  catch { throw new Error("Unable to read the case details. Refresh the page and try again."); }
  if (!response.ok) {
    const message = result.error?.message ?? "Unable to load dispute data. Please try again.";
    throw new Error(message);
  }
  return result as T;
}

export default function LiveDisputeWorkspace({ onShowDemo }: { onShowDemo: () => void }) {
  const [caseId, setCaseId] = useState("");
  const [currentCaseId, setCurrentCaseId] = useState("");
  const [items, setItems] = useState<DisputeSummary[]>([]);
  const [result, setResult] = useState<DisputeDetailResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [inputError, setInputError] = useState("");
  const [notice, setNotice] = useState("Connecting to PayPal Sandbox…");
  const [evidenceDrafts, setEvidenceDrafts] = useState<Record<string, CaseEvidenceDraft>>({});
  const requestRef = useRef<AbortController | null>(null);

  const query = useCallback((id?: string, preferredId?: string) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;

    const response = id
      ? readApi<DisputeDetailResult>(`/api/disputes/${encodeURIComponent(id)}`, controller.signal)
      : readApi<DisputeListResult>("/api/disputes", controller.signal);

    void response.then(async (firstResponse) => {
      if (controller.signal.aborted) return;
      let detail: DisputeDetailResult;
      if (id) {
        detail = firstResponse as DisputeDetailResult;
      } else {
        const list = firstResponse as DisputeListResult;
        const sortedItems = [...list.items].sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
        setItems(sortedItems);
        // Keep the selected case on refresh; otherwise open the latest case.
        const selectedId = sortedItems.find((item) => item.id === preferredId)?.id ?? sortedItems[0]?.id;
        if (!selectedId) {
          setCaseId("");
          setCurrentCaseId("");
          setNotice("No disputes were returned for this Sandbox account. You can still enter a known dispute ID.");
          return;
        }
        setCaseId(selectedId);
        setCurrentCaseId(selectedId);
        detail = await readApi<DisputeDetailResult>(`/api/disputes/${encodeURIComponent(selectedId)}`, controller.signal);
      }
      if (controller.signal.aborted) return;
      setResult(detail);
      setCaseId(detail.dispute.id);
      setCurrentCaseId(detail.dispute.id);
      setNotice(`Last refreshed ${date(detail.fetchedAt)} · PayPal Sandbox`);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      const message = failure instanceof Error ? failure.message : "Unable to load dispute data.";
      setError(message);
      setNotice("The case could not be refreshed. Please try again.");
    }).finally(() => {
      if (requestRef.current === controller && !controller.signal.aborted) setLoading(false);
    });
  }, []);

  function startQuery(id?: string) {
    if (id) {
      setCaseId(id);
      setCurrentCaseId(id);
    }
    setLoading(true);
    setResult(null);
    setError("");
    setInputError("");
    setNotice(id ? "Fetching dispute details from PayPal Sandbox…" : "Loading the merchant's disputes from PayPal Sandbox…");
    void query(id, currentCaseId);
  }

  useEffect(() => {
    void query();
    return () => requestRef.current?.abort();
  }, [query]);

  function loadCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = caseId.trim();
    if (!/^[A-Za-z0-9-]{1,255}$/.test(id)) {
      setInputError("Enter a dispute ID using letters, numbers, and hyphens.");
      return;
    }
    startQuery(id);
  }

  const dispute = result?.dispute;
  const transaction = dispute?.transactions[0];
  const merchant = transaction?.merchantName ?? "Sandbox merchant";
  const waiting = dispute?.status?.startsWith("WAITING_FOR_");
  const hasTracking = !!dispute?.tracking.length;
  const needsShipmentEvidence = hasTracking || !!dispute?.requestedEvidence.includes("PROOF_OF_FULFILLMENT") || ["MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "UNAUTHORISED"].includes(dispute?.reason ?? "");
  const buyerNames = [...new Set(dispute?.transactions.map((item) => item.buyerName).filter((name): name is string => !!name))];
  const sellerNames = [...new Set(dispute?.transactions.map((item) => item.merchantName).filter((name): name is string => !!name))];
  function partyName(author: string) {
    if (author === "BUYER") return buyerNames.length === 1 ? buyerNames[0] : "Buyer";
    if (author === "SELLER") return sellerNames.length === 1 ? sellerNames[0] : "Seller";
    return label(author);
  }
  const initiator = dispute?.initiatedBy ? partyName(dispute.initiatedBy) : "Not provided";
  const relatedItems = dispute?.transactions.flatMap((item) => item.items) ?? [];
  const guidance = responseGuidance[dispute?.status ?? ""] ?? { title: "Review the customer's concern.", description: "Use the case details and any evidence requests to understand what needs attention." };

  return (
    <div className={styles.app}>
      <a className={styles.skipLink} href="#workspace">Skip to workspace</a>
      <aside className={`${styles.sidebar} ${styles.liveSidebar}`} aria-label="Workspace navigation">
        <a className={styles.brand} href="#workspace" aria-label="Deflect workspace">
          <span className={styles.brandMark}><Icon name="shield" size={24} /></span>deflect<span className={styles.brandDot}>.</span>
        </a>
        <span className={styles.sidebarCaption}>THE DISPUTE WORKSPACE</span>
        <nav className={styles.nav}>
          <a className={styles.navActive} href="#workspace"><Icon name="grid" />Workspace<span className={styles.navCount}>{String(items.length).padStart(2, "0")}</span></a>
          <a href="#case-activity"><Icon name="history" />Case activity<Icon name="chevron" size={14} /></a>
        </nav>
        <section className={styles.caseDirectory} aria-labelledby="active-cases-title">
          <div className={styles.caseDirectoryHeading}>
            <h2 id="active-cases-title">ACTIVE CASES <span>{items.length}</span></h2>
            <button className={styles.caseListRefresh} disabled={loading} onClick={() => startQuery()} aria-label="Refresh dispute list"><Icon name="refresh" size={14} /></button>
          </div>
          {items.length ? <ul className={styles.caseList}>
            {items.map((item) => <li key={item.id}>
              <button className={styles.caseListButton} aria-label={`View dispute ${item.id}`} aria-pressed={currentCaseId === item.id} onClick={() => startQuery(item.id)}>
                <code>{item.id}</code>
                <span className={styles.caseListReason}>{label(item.reason)}</span>
                <strong>{money(item.amount)}</strong>
                <span className={styles.caseListStatus}>{label(item.status)}</span>
              </button>
            </li>)}
          </ul> : <p className={styles.caseListEmpty}>{loading ? "Loading account disputes…" : error ? "Could not load the account list. Refresh to try again." : "No disputes were returned for this account."}</p>}
        </section>
        <div className={styles.sidebarBottom}>
          <div className={styles.safetyCard}>
            <Icon name="shield" size={22} /><strong>Evidence before action.</strong>
            <p>Dispute facts come directly from PayPal. Delivery still needs verification.</p>
            <span><span className={styles.liveDot} />Sandbox · read only</span>
          </div>
          <div className={styles.profile}>
            <span className={styles.avatar}>{initials(transaction?.merchantName)}</span>
            <div><strong>{merchant}</strong><span>PayPal Sandbox</span></div><Icon name="lock" size={15} />
          </div>
        </div>
      </aside>

      <main id="workspace" className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.breadcrumb}>Workspace<Icon name="chevron" size={13} /><span>Disputes</span></div>
          <div className={styles.topbarRight}>
            <button className={styles.sourceSwitch} onClick={onShowDemo}>View demo studio<Icon name="arrow" size={14} /></button>
            <span className={styles.demoLabel}><span className={styles.liveDot} />PayPal Sandbox</span>
          </div>
        </header>
        <div className={styles.content}>
          <div className={styles.pageHeading}>
            <div><div className={styles.eyebrow}>CLARITY AT EVERY STEP</div><h1>Dispute workspace<span>.</span></h1><p>Understand the customer&apos;s concern and what needs attention.</p></div>
            <span className={styles.modePill}><Icon name="lock" size={14} />Sandbox / Read only</span>
          </div>

          <section className={`${styles.caseCard} ${styles.supportSummary}`} aria-label="Dispute summary" aria-busy={loading}>
            <div className={styles.caseCardTop}>
              <div className={styles.caseTitle}><span className={styles.caseIcon}><Icon name="message" size={21} /></span><div><span className={styles.smallLabel}>CUSTOMER DISPUTE</span><h2>{dispute ? label(dispute.reason) : loading ? "Loading dispute…" : "Choose a dispute"}</h2>{dispute && <p className={styles.caseReference}>Case {dispute.id}</p>}</div></div>
              <Badge tone={waiting ? "amber" : dispute?.status === "RESOLVED" ? "green" : "neutral"}><span className={styles.statusDot} />{dispute ? label(dispute.status) : loading ? "Fetching data" : "No data loaded"}</Badge>
            </div>
            <div className={styles.summaryGrid}>
              <div><span>Dispute amount</span><strong className={styles.money}>{dispute?.amount?.value ?? "—"} <small>{dispute?.amount?.currency ?? ""}</small></strong></div>
              <div><span>Raised by</span><strong>{dispute ? initiator : "—"}</strong><small>{dispute?.initiatedBy ? label(dispute.initiatedBy) : ""}</small></div>
              <div><span>Opened</span><strong>{dispute ? date(dispute.createdAt, "date") : "—"}</strong><small>{dispute?.createdAt ? date(dispute.createdAt, "time") : ""}</small></div>
              <div><span>Seller response due</span><strong>{dispute ? date(dispute.sellerResponseDueAt, "date") : "—"}</strong><small>{dispute?.sellerResponseDueAt ? date(dispute.sellerResponseDueAt, "time") : ""}</small></div>
            </div>
          </section>

          <div className={styles.controls}>
            <form className={styles.caseForm} onSubmit={loadCase}>
              <label htmlFor="case-id">Case reference</label>
              <input id="case-id" value={caseId} placeholder="Enter dispute ID" disabled={loading} onChange={(event) => { setCaseId(event.target.value); setInputError(""); }} aria-invalid={!!inputError} aria-describedby={inputError ? "case-error" : undefined} spellCheck={false} />
              <button className={styles.refreshButton} type="submit" disabled={loading} aria-label="Load dispute"><Icon name="refresh" size={15} /></button>
            </form>
          </div>
          {inputError && <p id="case-error" role="alert" className={styles.inputError}>{inputError}</p>}
          <div className={styles.notice} role="status" aria-live="polite">{notice}</div>
          {error && <div className={styles.errorBanner} role="alert"><Icon name="alert" size={20} /><div><strong>Could not load dispute data</strong><p>{error}</p></div><button className={styles.secondaryButton} onClick={() => startQuery(caseId.trim() || undefined)}>Try again</button></div>}

          <div className={styles.workspaceGrid}>
            <section className={styles.panel} aria-labelledby="case-context-title" aria-busy={loading}>
              <div className={styles.panelHeader}><h2 id="case-context-title"><span className={styles.sectionNumber}>01</span>Customer&apos;s concern</h2></div>
              <div className={styles.panelBody}>
                {!dispute ? <div className={styles.shippingEmpty}><span><Icon name={loading ? "refresh" : "file"} size={32} /></span><h3>{loading ? "Getting the case facts." : "Your case starts here."}</h3><p>{loading ? "Loading the current dispute details from PayPal Sandbox." : "Select an account dispute or enter its ID to view details."}</p></div> : <>
                    <div className={styles.blockHeading}><span><Icon name="message" size={16} />Conversation</span></div>
                    {dispute.messages.length ? dispute.messages.map((message, index) => <div className={`${styles.complaint} ${styles.supportComplaint}`} key={`${message.postedAt}-${index}`}>
                      <div className={styles.supportMessageMeta}><span className={styles.buyerAvatar}>{initials(partyName(message.author))}</span><div><strong>{partyName(message.author)}</strong><span>{label(message.author)}</span></div><time dateTime={message.postedAt ?? undefined}>{date(message.postedAt)}</time></div>
                      <blockquote>{message.content}</blockquote>
                    </div>) : <p className={styles.emptyText}>No messages were returned by PayPal.</p>}
                    <div className={styles.messageFooter}>Refund requested by the buyer<Badge>{dispute.buyerRequestedAmount ? money(dispute.buyerRequestedAmount) : "Not specified"}</Badge></div>
                    <div className={styles.liveBlockHeading}><span><Icon name="box" size={16} />Related items</span></div>
                    {relatedItems.length ? <ul className={styles.supportItems}>{relatedItems.map((item, index) => <li key={index}><Icon name="box" size={18} /><div><strong>{item.name ?? "Item name not provided"}</strong>{item.quantity && <span>Quantity: {item.quantity}</span>}</div></li>)}</ul> : <p className={styles.emptyText}>Item details are not available for this case.</p>}
                    <dl className={styles.facts}>
                      <Fact label="Customer">{buyerNames.join(", ") || "Not provided"}</Fact>
                      <Fact label="Store">{sellerNames.join(", ") || "Not provided"}</Fact>
                    </dl>
                </>}
              </div>
            </section>

            <section className={styles.panel} aria-labelledby="response-title" aria-busy={loading}>
              <div className={styles.panelHeader}><h2 id="response-title"><span className={styles.sectionNumber}>02</span>Response details</h2><Badge>Read only</Badge></div>
              <div className={styles.panelBody}>
                {!dispute ? <p className={styles.emptyText}>{loading ? "Loading response requirements…" : "Select a case to view its response requirements."}</p> : <>
                  <div className={styles.supportGuidance}><Icon name={dispute.status === "RESOLVED" ? "check" : "message"} size={21} /><div><h3>{guidance.title}</h3><p>{guidance.description}</p></div></div>
                  <div className={styles.liveBlockHeading}><span><Icon name="file" size={16} />Evidence requested by PayPal</span></div>
                  {dispute.requestedEvidence.length ? <ul className={styles.supportEvidence}>{dispute.requestedEvidence.map((evidence) => <li key={evidence}><span className={styles.statusDot} />{label(evidence)}</li>)}</ul> : <p className={styles.emptyText}>No specific evidence request is listed for this case.</p>}
                  {needsShipmentEvidence && <div className={styles.fulfillmentCallout}><Icon name="truck" size={22} /><div><strong>{hasTracking ? "Delivery still needs confirmation" : "Delivery status is unknown"}</strong><p>{hasTracking ? "Shipment tracking was supplied with the case, but delivery has not been verified." : "No shipment tracking was supplied with this case. There is no confirmed delivery information here."}</p>{hasTracking && <p>Carrier: {[...new Set(dispute.tracking.map((item) => item.carrier).filter(Boolean))].join(", ") || "Not provided"}</p>}</div></div>}
                  <dl className={styles.facts}>
                    <Fact label="PayPal refund limit"><strong>{money(dispute.allowedRefundAmount)}</strong></Fact>
                    {dispute.transactions.some((item) => item.status === "HELD") && <Fact label="Payment status"><Badge tone="amber">Funds held</Badge></Fact>}
                  </dl>
                  <p className={styles.supportNote}>The refund limit is reported by PayPal. A refund decision has not been made here.</p>
                  <div id="case-activity" className={styles.supportActivity}>
                    <div className={styles.liveBlockHeading}><span><Icon name="history" size={16} />Case activity</span><span className={styles.smallMuted}>Pacific time</span></div>
                    <dl className={styles.supportDates}>
                      <div><dt>Opened</dt><dd><time dateTime={dispute.createdAt ?? undefined}>{date(dispute.createdAt)}</time></dd></div>
                      <div><dt>Last updated</dt><dd><time dateTime={dispute.updatedAt ?? undefined}>{date(dispute.updatedAt)}</time></dd></div>
                      <div><dt>Seller response due</dt><dd><time dateTime={dispute.sellerResponseDueAt ?? undefined}>{date(dispute.sellerResponseDueAt)}</time></dd></div>
                    </dl>
                  </div>
                </>}
              </div>
            </section>
          </div>
          {dispute && <DisputeEvidence key={dispute.id} dispute={dispute} draft={evidenceDrafts[dispute.id] ?? EMPTY_CASE_EVIDENCE} onChange={(draft) => setEvidenceDrafts((previous) => ({ ...previous, [dispute.id]: draft }))} />}
          <footer className={styles.footer}><span><Icon name="shield" size={13} />Built on facts. Bounded by policy.</span><span>Deflect <span className={styles.footerDot}>·</span>PayPal Sandbox connection</span></footer>
        </div>
      </main>
    </div>
  );
}
