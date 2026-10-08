"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { DisputeDetailResult, DisputeListResult, DisputeSummary, Money } from "@/lib/disputes";
import { Badge, Fact, Icon } from "./workspace-ui";
import styles from "./dispute-workspace.module.css";

const timeZone = "America/Los_Angeles";
const labels: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Item not as described",
  WAITING_FOR_SELLER_RESPONSE: "Awaiting seller response",
  WAITING_FOR_BUYER_RESPONSE: "Awaiting buyer response",
  UNDER_REVIEW: "Under review",
  HELD: "Funds held",
  PROOF_OF_FULFILLMENT: "Proof of fulfillment",
  PROOF_OF_REFUND: "Proof of refund",
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
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(new Date(value));
}
function initials(name: string | null | undefined): string {
  return name?.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "—";
}
async function readApi<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store" });
  let result;
  try { result = await response.json(); }
  catch { throw new Error("The backend returned an unreadable response. Refresh the page and try again."); }
  if (!response.ok) {
    const message = result.error?.message ?? "Unable to load dispute data. Please try again.";
    throw new Error(result.error?.debugId ? `${message} Reference: ${result.error.debugId}` : message);
  }
  return result as T;
}

type QueryEvent = { id: number; time: string; title: string; detail: string; failed: boolean };

export default function LiveDisputeWorkspace({ onShowDemo }: { onShowDemo: () => void }) {
  const [caseId, setCaseId] = useState("");
  const [items, setItems] = useState<DisputeSummary[]>([]);
  const [result, setResult] = useState<DisputeDetailResult | null>(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [inputError, setInputError] = useState("");
  const [notice, setNotice] = useState("Connecting to PayPal Sandbox…");
  const [events, setEvents] = useState<QueryEvent[]>([]);
  const requestRef = useRef<AbortController | null>(null);
  const eventRef = useRef(0);

  const query = useCallback((id?: string) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;

    function record(title: string, detail: string, failed = false) {
      const entry = { id: ++eventRef.current, time: new Date().toISOString(), title, detail, failed };
      setEvents((entries) => [...entries, entry]);
    }

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
        setItems(list.items);
        record("Dispute list retrieved", `${list.items.length} disputes returned by PayPal`);
        // Select the most recently updated item in the returned page.
        const selectedId = [...list.items].sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0))[0]?.id;
        if (!selectedId) {
          setCaseId("");
          setNotice("No disputes were returned for this Sandbox account. You can still enter a known dispute ID.");
          return;
        }
        setCaseId(selectedId);
        detail = await readApi<DisputeDetailResult>(`/api/disputes/${encodeURIComponent(selectedId)}`, controller.signal);
      }
      if (controller.signal.aborted) return;
      setResult(detail);
      setCaseId(detail.dispute.id);
      setNotice(`PayPal Sandbox data · retrieved ${date(detail.fetchedAt)} · read only`);
      record("Dispute details retrieved", `${detail.dispute.id} · ${label(detail.dispute.status)}`);
      record("Case facts displayed", `${detail.dispute.transactions.length} transactions · ${detail.dispute.messages.length} messages · ${detail.dispute.requestedEvidence.length} requested evidence types`);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      const message = failure instanceof Error ? failure.message : "Unable to load dispute data.";
      setError(message);
      setNotice("Query failed. No sample data has been substituted.");
      record("PayPal query failed", message, true);
    }).finally(() => {
      if (requestRef.current === controller && !controller.signal.aborted) setLoading(false);
    });
  }, []);

  function startQuery(id?: string) {
    if (id) setCaseId(id);
    setLoading(true);
    setResult(null);
    setError("");
    setInputError("");
    setNotice(id ? "Fetching dispute details from PayPal Sandbox…" : "Loading the merchant's disputes from PayPal Sandbox…");
    void query(id);
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
  const selectedId = items.some((item) => item.id === caseId) ? caseId : "";

  return (
    <div className={styles.app}>
      <a className={styles.skipLink} href="#workspace">Skip to workspace</a>
      <aside className={styles.sidebar} aria-label="Workspace navigation">
        <a className={styles.brand} href="#workspace" aria-label="Deflect workspace">
          <span className={styles.brandMark}><Icon name="shield" size={24} /></span>deflect<span className={styles.brandDot}>.</span>
        </a>
        <span className={styles.sidebarCaption}>THE DISPUTE WORKSPACE</span>
        <nav className={styles.nav}>
          <a className={styles.navActive} href="#workspace"><Icon name="grid" />Workspace<span className={styles.navCount}>01</span></a>
          <a href="#audit"><Icon name="history" />Query history<Icon name="chevron" size={14} /></a>
        </nav>
        <div className={styles.sidebarCase}>
          <span className={styles.sidebarLabel}>ACTIVE CASE</span>
          <div className={styles.caseDot}>{dispute ? label(dispute.reason) : loading ? "Loading dispute…" : "No case selected"}</div>
          <code>{dispute?.id ?? "—"}</code>
          <span className={styles.sidebarAmount}>{dispute?.amount?.value ?? "—"} <span>{dispute?.amount?.currency ?? ""}</span></span>
        </div>
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
            <div><div className={styles.eyebrow}>CLARITY AT EVERY STEP</div><h1>Dispute workspace<span>.</span></h1><p>Current case facts, straight from PayPal.</p></div>
            <span className={styles.modePill}><Icon name="lock" size={14} />Sandbox / Read only</span>
          </div>

          <section className={styles.caseCard} aria-label="Dispute summary" aria-busy={loading}>
            <div className={styles.caseCardTop}>
              <div className={styles.caseTitle}><span className={styles.caseIcon}><Icon name="file" size={21} /></span><div><span className={styles.smallLabel}>DISPUTE ID</span><h2>{dispute?.id ?? (loading ? "Loading dispute…" : "Choose a dispute")}</h2></div></div>
              <Badge tone={waiting ? "amber" : dispute?.status === "RESOLVED" ? "green" : "neutral"}><span className={styles.statusDot} />{dispute ? label(dispute.status) : loading ? "Fetching data" : "No data loaded"}</Badge>
            </div>
            <div className={styles.summaryGrid}>
              <div><span>Dispute amount</span><strong className={styles.money}>{dispute?.amount?.value ?? "—"} <small>{dispute?.amount?.currency ?? ""}</small></strong></div>
              <div><span>Reason</span><strong>{dispute ? label(dispute.reason) : "—"}</strong><small>{dispute ? label(dispute.state) : ""}</small></div>
              <div><span>Lifecycle stage</span><strong>{dispute ? label(dispute.stage) : "—"}</strong><small>{dispute?.channel ? `${label(dispute.channel)} dispute` : ""}</small></div>
              <div><span>Response due</span><strong>{dispute ? date(dispute.sellerResponseDueAt, "date") : "—"}</strong><small>{dispute?.sellerResponseDueAt ? date(dispute.sellerResponseDueAt, "time") : ""}</small></div>
            </div>
          </section>

          <div className={styles.controls}>
            <form className={styles.caseForm} onSubmit={loadCase}>
              <label htmlFor="case-id">Case</label>
              <input id="case-id" value={caseId} placeholder="Enter dispute ID" disabled={loading} onChange={(event) => { setCaseId(event.target.value); setInputError(""); }} aria-invalid={!!inputError} aria-describedby={inputError ? "case-error" : undefined} spellCheck={false} />
              <button className={styles.refreshButton} type="submit" disabled={loading} aria-label="Load dispute"><Icon name="refresh" size={15} /></button>
            </form>
            <div className={styles.scenarioControl}>
              <label htmlFor="account-disputes">Account disputes</label>
              <select id="account-disputes" value={selectedId} disabled={loading || !items.length} onChange={(event) => { if (event.target.value) startQuery(event.target.value); }}>
                <option value="">{loading ? "Loading…" : items.length ? "Select a dispute" : "No disputes listed"}</option>
                {items.map((item) => <option key={item.id} value={item.id}>{item.id} · {money(item.amount)}</option>)}
              </select>
              <button className={styles.refreshButton} disabled={loading} onClick={() => startQuery()} aria-label="Refresh dispute list"><Icon name="refresh" size={15} /></button>
            </div>
          </div>
          {inputError && <p id="case-error" role="alert" className={styles.inputError}>{inputError}</p>}
          <div className={styles.notice} role="status" aria-live="polite">{notice}</div>
          {error && <div className={styles.errorBanner} role="alert"><Icon name="alert" size={20} /><div><strong>Could not load dispute data</strong><p>{error}</p></div><button className={styles.secondaryButton} onClick={() => startQuery(caseId.trim() || undefined)}>Try again</button></div>}

          <div className={styles.workspaceGrid}>
            <section className={styles.panel} aria-labelledby="case-context-title" aria-busy={loading}>
              <div className={styles.panelHeader}><h2 id="case-context-title"><span className={styles.sectionNumber}>01</span>Case context</h2><span className={styles.smallMuted}>PayPal dispute details</span></div>
              <div className={styles.tabs} aria-label="Case context views">
                {[["overview", "Overview"], ["order", "Transactions"], ["shipping", "Fulfillment"]].map(([id, title]) => <button key={id} className={activeTab === id ? styles.tabActive : ""} onClick={() => setActiveTab(id)} aria-pressed={activeTab === id}>{title}</button>)}
              </div>
              <div className={styles.panelBody}>
                {!dispute ? <div className={styles.shippingEmpty}><span><Icon name={loading ? "refresh" : "file"} size={32} /></span><h3>{loading ? "Getting the case facts." : "Your case starts here."}</h3><p>{loading ? "Loading the current dispute details from PayPal Sandbox." : "Select an account dispute or enter its ID to view details."}</p></div> : <>
                  {activeTab === "overview" && <>
                    <div className={styles.blockHeading}><span><Icon name="message" size={16} />Case messages</span><Badge>Untrusted input</Badge></div>
                    {dispute.messages.length ? dispute.messages.map((message, index) => <div className={styles.complaint} key={`${message.postedAt}-${index}`}>
                      <div className={styles.messageMeta}><span className={styles.buyerAvatar}>{message.author === "BUYER" ? initials(transaction?.buyerName) : initials(message.author)}</span><strong>{message.author === "BUYER" ? transaction?.buyerName ?? "Buyer" : label(message.author)}</strong><span>{date(message.postedAt)}</span></div>
                      <blockquote>{message.content}</blockquote>
                    </div>) : <p className={styles.emptyText}>No messages were returned by PayPal.</p>}
                    <div className={styles.messageFooter}>Buyer&apos;s requested amount<Badge>{money(dispute.buyerRequestedAmount)}</Badge></div>
                    <div className={styles.liveBlockHeading}><span><Icon name="box" size={16} />Transaction facts</span><span className={styles.sourceLabel}>PayPal Sandbox</span></div>
                    <dl className={styles.facts}>
                      <Fact label="Seller transaction"><code>{transaction?.sellerTransactionId ?? "Not provided"}</code></Fact>
                      <Fact label="Order items">{transaction?.items.map((item) => item.name ?? "Unnamed item").join(", ") || "Not provided"}</Fact>
                      <Fact label="Transaction status"><Badge tone={transaction?.status === "HELD" ? "amber" : "neutral"}>{label(transaction?.status)}</Badge></Fact>
                      <Fact label="Allowed refund"><strong>{money(dispute.allowedRefundAmount)}</strong></Fact>
                      <Fact label="Evidence requested">{dispute.requestedEvidence.map(label).join(", ") || "None returned"}</Fact>
                    </dl>
                    <div className={styles.fulfillmentCallout}><Icon name="truck" size={22} /><div><strong>{hasTracking ? "Tracking supplied in case evidence" : "Delivery status is unknown"}</strong><p>{hasTracking ? "Tracking details are available below. Carrier delivery status has not been independently checked." : "No tracking was returned in the dispute details. Order and carrier lookups are not connected yet."}</p></div></div>
                    <div className={styles.liveBlockHeading}><span><Icon name="shield" size={16} />Available PayPal actions</span><span className={styles.sourceLabel}>API capabilities</span></div>
                    <div className={styles.factChips}>{dispute.availableActions.length ? dispute.availableActions.map((action) => <span key={action}>{label(action)}</span>) : <p className={styles.emptyText}>No actions were returned for the current case state.</p>}</div>
                    <p className={styles.actionFootnote}>Availability does not mean Policy approval. This connection is read only.</p>
                  </>}

                  {activeTab === "order" && <>
                    <div className={styles.blockHeading}><span><Icon name="box" />Disputed transactions</span><Badge>{dispute.transactions.length} returned</Badge></div>
                    {dispute.transactions.map((item, index) => <div key={`${item.sellerTransactionId}-${index}`} className={styles.transactionGroup}>
                      <dl className={styles.facts}>
                        <Fact label="Merchant">{item.merchantName ?? "Not provided"}</Fact>
                        <Fact label="Merchant ID"><code>{item.merchantId ?? "Not provided"}</code></Fact>
                        <Fact label="Buyer">{item.buyerName ?? "Not provided"}</Fact>
                        <Fact label="Seller transaction"><code>{item.sellerTransactionId ?? "Not provided"}</code></Fact>
                        <Fact label="Buyer transaction"><code>{item.buyerTransactionId ?? "Not provided"}</code></Fact>
                        <Fact label="Gross payment">{money(item.amount)}</Fact>
                        <Fact label="Status">{label(item.status)}</Fact>
                        {item.items.map((product, productIndex) => <Fact key={productIndex} label={`Item ${productIndex + 1}`}>{product.name ?? "Not provided"}{product.quantity ? ` · qty ${product.quantity}` : ""}</Fact>)}
                      </dl>
                    </div>)}
                    {!dispute.transactions.length && <p className={styles.emptyText}>No transaction details were returned.</p>}
                    <div className={styles.liveBlockHeading}><span>Funds movement history</span></div>
                    <dl className={styles.facts}>{dispute.fundMovements.map((movement, index) => <Fact key={index} label={label(movement.reason)}>{money(movement.amount)}<small className={styles.factDate}>{date(movement.time)}</small></Fact>)}</dl>
                    {!dispute.fundMovements.length && <p className={styles.emptyText}>No funds movements were returned.</p>}
                    <div className={styles.neutralNote}><Icon name="file" /><p>These are records from the dispute response. A separate PayPal Order or merchant fulfillment lookup has not been performed.</p></div>
                  </>}

                  {activeTab === "shipping" && <>
                    <div className={styles.blockHeading}><span><Icon name="truck" />Fulfillment evidence</span><Badge tone="amber">Delivery unverified</Badge></div>
                    {hasTracking ? <>
                      {dispute.tracking.map((tracking, index) => <dl className={`${styles.facts} ${styles.transactionGroup}`} key={index}><Fact label="Carrier">{tracking.carrier ?? "Not provided"}</Fact><Fact label="Tracking number"><code>{tracking.number ?? "Not provided"}</code></Fact><Fact label="Source">PayPal case evidence</Fact><Fact label="Delivery status">Not independently verified</Fact></dl>)}
                      <div className={styles.neutralNote}><Icon name="file" /><p>A tracking number is evidence supplied in the case. A carrier query is needed to confirm actual delivery.</p></div>
                    </> : <div className={styles.shippingEmpty}><span><Icon name="truck" size={32} /></span><h3>A missing piece of the story.</h3><p>No tracking was included in the PayPal dispute response. Fulfillment status remains unknown.</p>{dispute.requestedEvidence.includes("PROOF_OF_FULFILLMENT") && <Badge tone="amber">Proof of fulfillment requested</Badge>}</div>}
                  </>}

                  <details className={styles.rawDetails}><summary>View PayPal response<Icon name="chevron" size={13} /></summary><pre>{JSON.stringify(dispute.raw, null, 2)}</pre></details>
                </>}
              </div>
            </section>

            <section className={styles.panel} aria-labelledby="decision-title">
              <div className={styles.panelHeader}><h2 id="decision-title"><span className={styles.sectionNumber}>02</span>Decision studio</h2><Badge>Not connected</Badge></div>
              <div className={styles.panelBody}>
                <div className={styles.recommendation}>
                  <div className={styles.recommendationTop}><span><Icon name="shield" size={16} />Facts first</span><Badge tone="green">Read only</Badge></div>
                  <h3>{dispute ? "The case facts are in." : "Start with the case facts."}</h3>
                  <p>AI recommendations and Policy / JEV validation will follow once the decision pipeline is connected.</p>
                </div>
                <div className={styles.pipelineList}>
                  <div><span className={styles.checkIcon}><Icon name={dispute ? "check" : "refresh"} size={14} /></span><div><strong>PayPal dispute details</strong><p>{dispute ? `Loaded ${date(result?.fetchedAt)}` : loading ? "Loading from Sandbox" : "Waiting for a successful query"}</p></div></div>
                  <div><span className={styles.sectionNumber}>02</span><div><strong>Order & carrier facts</strong><p>Additional source connections needed</p></div></div>
                  <div><span className={styles.sectionNumber}>03</span><div><strong>AI recommendation</strong><p>No model has been called for this case</p></div></div>
                  <div><span className={styles.sectionNumber}>04</span><div><strong>Policy / JEV validation</strong><p>No execution approval has been issued</p></div></div>
                </div>
                <div className={styles.neutralNote}><Icon name="lock" /><p>This workspace retrieves dispute data. It does not send replies, submit evidence, or move funds.</p></div>
                <button className={`${styles.secondaryButton} ${styles.demoStudioButton}`} onClick={onShowDemo}>Explore demo studio<Icon name="arrow" size={16} /></button>
                <p className={styles.actionFootnote}>Demo scenarios use separate, fixed sample data.</p>
              </div>
            </section>
          </div>

          <section id="audit" className={`${styles.panel} ${styles.auditPanel}`} aria-labelledby="audit-title">
            <div className={styles.panelHeader}><h2 id="audit-title"><span className={styles.sectionNumber}>03</span>Query history<span className={styles.auditCount}>{events.length}</span></h2><span className={styles.smallMuted}>Current browser session</span></div>
            <div className={styles.auditBody}>
              <div className={styles.auditColumnLabels}><span>TIME · PACIFIC</span><span>EVENT</span><span>OUTCOME</span></div>
              <ol className={styles.auditList}>{events.map((entry) => <li key={entry.id}><time dateTime={entry.time}>{new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone }).format(new Date(entry.time))}</time><div className={styles.auditEvent}><span className={`${styles.auditDot} ${styles[entry.failed ? "fail" : "pass"]}`} /><div><strong>{entry.title}</strong><p>{entry.detail}</p></div></div><Badge tone={entry.failed ? "red" : "green"}>{entry.failed ? "Failed" : "Retrieved"}</Badge></li>)}</ol>
              {!events.length && <p className={styles.emptyText}>Query results will appear here. This session history resets on reload.</p>}
            </div>
          </section>
          <footer className={styles.footer}><span><Icon name="shield" size={13} />Built on facts. Bounded by policy.</span><span>Deflect <span className={styles.footerDot}>·</span>PayPal Sandbox connection</span></footer>
        </div>
      </main>
    </div>
  );
}
