export type Money = { currency: string; value: string };
export type DisputeSummary = {
  id: string;
  reason: string | null;
  status: string | null;
  stage: string | null;
  amount: Money | null;
  updatedAt: string | null;
};
export type DisputeTransaction = {
  sellerTransactionId: string | null;
  buyerTransactionId: string | null;
  status: string | null;
  amount: Money | null;
  buyerName: string | null;
  merchantName: string | null;
  merchantId: string | null;
  items: { name: string | null; quantity: string | null }[];
};
export type DisputeMessage = {
  author: string;
  content: string;
  postedAt: string | null;
};
export type DisputeDetail = DisputeSummary & {
  createdAt: string | null;
  state: string | null;
  channel: string | null;
  sellerResponseDueAt: string | null;
  buyerRequestedAmount: Money | null;
  allowedRefundAmount: Money | null;
  transactions: DisputeTransaction[];
  messages: DisputeMessage[];
  requestedEvidence: string[];
  tracking: { carrier: string | null; number: string | null }[];
  fundMovements: { reason: string | null; party: string | null; amount: Money | null; time: string | null }[];
  availableActions: string[];
  allowedResponseOptions: Record<string, unknown>;
  raw: Record<string, unknown>;
};
export type DisputeListResult = { items: DisputeSummary[]; fetchedAt: string; environment: "sandbox" };
export type DisputeDetailResult = { dispute: DisputeDetail; fetchedAt: string; environment: "sandbox" };
export type DisputeApiError = { error: { code: string; message: string; debugId?: string } };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function money(value: unknown): Money | null {
  const input = record(value);
  const currency = text(input.currency_code);
  const amount = text(input.value);
  return currency && amount ? { currency, value: amount } : null;
}

export function normalizeDisputeSummary(value: unknown): DisputeSummary {
  const input = record(value);
  const id = text(input.dispute_id);
  if (!id) throw new Error("PayPal returned a dispute without an ID.");
  return {
    id,
    reason: text(input.reason),
    status: text(input.status),
    stage: text(input.dispute_life_cycle_stage),
    amount: money(input.dispute_amount),
    updatedAt: text(input.update_time),
  };
}

export function normalizeDisputeList(value: unknown): DisputeSummary[] {
  const input = record(value);
  if (!Array.isArray(input.items)) throw new Error("PayPal returned an invalid dispute list.");
  return input.items.map(normalizeDisputeSummary);
}

export function normalizeDisputeDetail(value: unknown): DisputeDetail {
  const input = record(value);
  const summary = normalizeDisputeSummary(input);
  const evidences = list(input.evidences).map(record);
  const messages: DisputeMessage[] = list(input.messages).flatMap((value) => {
    const message = record(value);
    const content = text(message.content);
    return content ? [{ author: text(message.posted_by) ?? "UNKNOWN", content, postedAt: text(message.time_posted) }] : [];
  });
  // CREATE evidence may repeat the original buyer message; never count it twice.
  const knownBuyerMessages = new Set(messages.filter((message) => message.author === "BUYER").map((message) => message.content));
  for (const evidence of evidences) {
    const content = text(evidence.notes);
    if (evidence.source === "SUBMITTED_BY_BUYER" && evidence.evidence_type === "CREATE" && content && !knownBuyerMessages.has(content)) {
      messages.push({ author: "BUYER", content, postedAt: text(evidence.date) });
      knownBuyerMessages.add(content);
    }
  }
  const tracking = evidences.flatMap((evidence) => list(record(evidence.evidence_info).tracking_info).map((value) => {
    const item = record(value);
    return { carrier: text(item.carrier_name_other) ?? text(item.carrier_name), number: text(item.tracking_number) };
  })).filter((item) => item.carrier || item.number);
  const trackingKeys = new Set<string>();

  return {
    ...summary,
    createdAt: text(input.create_time),
    state: text(input.dispute_state),
    channel: text(input.dispute_channel),
    sellerResponseDueAt: text(input.seller_response_due_date),
    buyerRequestedAmount: money(record(input.offer).buyer_requested_amount),
    allowedRefundAmount: money(record(input.refund_details).allowed_refund_amount),
    transactions: list(input.disputed_transactions).map((value) => {
      const transaction = record(value);
      const buyer = record(transaction.buyer);
      const seller = record(transaction.seller);
      return {
        sellerTransactionId: text(transaction.seller_transaction_id),
        buyerTransactionId: text(transaction.buyer_transaction_id),
        status: text(transaction.transaction_status),
        amount: money(transaction.gross_amount),
        buyerName: text(buyer.name),
        merchantName: text(seller.name),
        merchantId: text(seller.merchant_id),
        items: list(transaction.items).map((value) => {
          const item = record(value);
          return { name: text(item.item_name), quantity: text(item.item_quantity) };
        }),
      };
    }),
    messages,
    requestedEvidence: [...new Set(evidences.filter((evidence) => evidence.source === "REQUESTED_FROM_SELLER").flatMap((evidence) => text(evidence.evidence_type) ? [text(evidence.evidence_type)!] : []))],
    tracking: tracking.filter((item) => {
      const key = `${item.carrier}\0${item.number}`;
      if (trackingKeys.has(key)) return false;
      trackingKeys.add(key);
      return true;
    }),
    fundMovements: list(input.fund_movements).map((value) => {
      const movement = record(value);
      return { reason: text(movement.reason), party: text(movement.party), amount: money(movement.amount), time: text(movement.initiated_time) };
    }),
    availableActions: [...new Set(list(input.links).map(record).filter((link) => link.method === "POST").flatMap((link) => text(link.rel) ? [text(link.rel)!] : []))],
    allowedResponseOptions: record(input.allowed_response_options),
    raw: input,
  };
}
