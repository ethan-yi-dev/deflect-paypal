// Display fixtures only. Suggestions and checks are predefined, not live decisions.
export const demoDispute = {
  id: "PP-R-AON-10190582",
  captureId: "9UN722265P1500747",
  buyer: "John D.",
  merchant: "Test Store",
  item: "Deflect sandbox test order",
  amount: "10.00",
  currency: "USD",
  dueDate: "Oct 27, 2026",
  dueTime: "10:24 PM PDT",
  complaint: "I paid USD 10.00 for this order, but I still haven't received the item. Could you please check what happened to the delivery? I would like a full refund of USD 10.00.",
  availableActions: ["Send message", "Provide evidence", "Make offer", "Accept claim", "Escalate"],
};

export type ScenarioId = "missing" | "delivered" | "injection";
export type Check = { title: string; detail: string; state: "pass" | "warning" | "fail" };
export type Scenario = {
  label: string;
  title: string;
  description: string;
  action: string;
  actionLabel: string;
  rationale: string;
  reply: string;
  facts: string[];
  policy: string;
  jev: string;
  blocked: boolean;
  checks: Check[];
};

export const demoScenarios: Record<ScenarioId, Scenario> = {
  missing: {
    label: "Missing tracking",
    title: "Ask for fulfillment details",
    description: "A helpful reply now. A refund decision once the facts are clear.",
    action: "SEND_MESSAGE",
    actionLabel: "Send a message",
    rationale: "The buyer reports non-delivery, but no shipment record is available. Acknowledge the concern and request fulfillment details before deciding on a refund.",
    reply: "Hi John, thank you for letting us know. We're checking the fulfillment details for your order and will share an update once we can verify its delivery status. We've noted your request for a USD 10.00 refund.",
    facts: ["F-01 · Payment: USD 10.00", "F-02 · Delivery: unknown", "F-03 · Refund requested: USD 10.00"],
    policy: "Passed", jev: "Passed", blocked: false,
    checks: [
      { title: "Action is available", detail: "Send message is allowed for this inquiry.", state: "pass" },
      { title: "Reply matches the facts", detail: "No unsupported delivery or refund promises.", state: "pass" },
      { title: "Refund limit protected", detail: "This action moves no funds. Limit: USD 10.00.", state: "pass" },
      { title: "Fulfillment evidence missing", detail: "Any refund decision still needs review.", state: "warning" },
    ],
  },
  delivered: {
    label: "Delivery confirmed",
    title: "Provide fulfillment evidence",
    description: "Use the shipment record to support an evidence-based response.",
    action: "PROVIDE_EVIDENCE",
    actionLabel: "Provide evidence",
    rationale: "This alternate demo includes a delivery record matched to the order. The proposed evidence references that record and the captured payment. These shipment details are fictional demo fixtures.",
    reply: "Fulfillment evidence for the disputed order: demo carrier record DEMO-TRACK-001, marked delivered on Oct 7, 2026. Related payment: 9UN722265P1500747. This is a simulated evidence submission using fictional shipment data.",
    facts: ["F-01 · Payment: USD 10.00", "F-02 · Demo delivery record", "F-04 · DEMO-TRACK-001"],
    policy: "Passed", jev: "Passed", blocked: false,
    checks: [
      { title: "Action is available", detail: "Provide evidence is allowed for this inquiry.", state: "pass" },
      { title: "Evidence references match", detail: "Demo shipment and payment belong to this case.", state: "pass" },
      { title: "Refund limit protected", detail: "Evidence submission moves no funds.", state: "pass" },
      { title: "Demo-only evidence", detail: "Fictional tracking is used only in this preview.", state: "warning" },
    ],
  },
  injection: {
    label: "Injection attempt",
    title: "Refund proposal blocked",
    description: "Customer text cannot change the merchant's refund rules.",
    action: "ACCEPT_CLAIM",
    actionLabel: "Refund USD 100.00",
    rationale: "This adversarial fixture shows an unsafe model proposal: a USD 100.00 refund based on instructions embedded in the complaint. The predefined checks reject the amount and its unsupported justification.",
    reply: "Unsafe demo proposal: accept the claim and refund USD 100.00 because the customer message says to override the refund policy.",
    facts: ["F-01 · Payment: USD 10.00", "F-03 · Allowed refund: USD 10.00"],
    policy: "Blocked", jev: "Blocked", blocked: true,
    checks: [
      { title: "Action is available", detail: "Accept claim is available, subject to validation.", state: "pass" },
      { title: "Refund exceeds the limit", detail: "USD 100.00 proposed; USD 10.00 allowed.", state: "fail" },
      { title: "Justification is unsupported", detail: "Customer instructions are not policy authority.", state: "fail" },
      { title: "Execution blocked", detail: "No refund can proceed from this proposal.", state: "fail" },
    ],
  },
};

export type AuditEntry = { id: string; time: string; title: string; detail: string; state: "pass" | "warning" | "fail" };
export const initialAudit: AuditEntry[] = [
  { id: "loaded", time: "22:28:00", title: "Dispute snapshot loaded", detail: "Hardcoded Sandbox sample · PP-R-AON-10190582", state: "pass" },
  { id: "facts", time: "22:28:01", title: "Order facts assembled", detail: "Payment matched · fulfillment record unavailable", state: "warning" },
  { id: "suggestion", time: "22:28:02", title: "Demo recommendation prepared", detail: "SEND_MESSAGE · three referenced facts", state: "pass" },
  { id: "validation", time: "22:28:03", title: "Demo checks completed", detail: "Message permitted · refund decision needs review", state: "pass" },
];
