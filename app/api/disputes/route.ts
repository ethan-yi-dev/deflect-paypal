import { disputeErrorResponse, disputeResponseHeaders, paypalDisputes } from "@/lib/paypal-disputes";

export const runtime = "nodejs";

export async function GET() {
  try {
    const items = await paypalDisputes.listDisputes();
    return Response.json({ items, fetchedAt: new Date().toISOString(), environment: "sandbox" }, { headers: disputeResponseHeaders });
  } catch (error) {
    return disputeErrorResponse(error);
  }
}
