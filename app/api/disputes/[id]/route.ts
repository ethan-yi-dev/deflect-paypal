import { disputeErrorResponse, disputeResponseHeaders, paypalDisputes } from "@/lib/paypal-disputes";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const dispute = await paypalDisputes.getDispute(id);
    return Response.json({ dispute, fetchedAt: new Date().toISOString(), environment: "sandbox" }, { headers: disputeResponseHeaders });
  } catch (error) {
    return disputeErrorResponse(error);
  }
}
