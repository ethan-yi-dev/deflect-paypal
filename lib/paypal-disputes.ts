import "server-only";
import { createPayPalDisputesClient, PayPalDisputesError } from "./paypal-disputes-client";

export const paypalDisputes = createPayPalDisputesClient(() => ({
  clientId: process.env.PAYPAL_CLIENT_ID,
  secret: process.env.PAYPAL_SECRET,
}));

export const disputeResponseHeaders = { "Cache-Control": "private, no-store" };

export function disputeErrorResponse(error: unknown) {
  if (error instanceof PayPalDisputesError) {
    return Response.json({ error: { code: error.code, message: error.message, ...(error.debugId ? { debugId: error.debugId } : {}) } }, { status: error.status, headers: disputeResponseHeaders });
  }
  return Response.json({ error: { code: "INTERNAL_ERROR", message: "Unable to load dispute data. Please try again." } }, { status: 500, headers: disputeResponseHeaders });
}
