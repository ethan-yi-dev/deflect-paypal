import { normalizeDisputeDetail, normalizeDisputeList } from "./disputes";

const PAYPAL_SANDBOX = "https://api-m.sandbox.paypal.com";

export class PayPalDisputesError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly debugId?: string) {
    super(message);
    this.name = "PayPalDisputesError";
  }
}

export class PayPalEvidenceError extends PayPalDisputesError {
  constructor(code: string, message: string, status: number, public readonly outcome: "rejected" | "unknown", debugId?: string) { super(code, message, status, debugId); }
}

// Fixed Sandbox URLs only. Evidence POSTs are explicit and are never retried.
export function createPayPalDisputesClient(
  credentials: () => { clientId?: string; secret?: string },
  request: typeof fetch = fetch,
) {
  let cachedToken: { value: string; expiresAt: number } | undefined;
  let pendingToken: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const { clientId, secret } = credentials();
    if (!clientId || !secret) {
      throw new PayPalDisputesError("PAYPAL_NOT_CONFIGURED", "Set PAYPAL_CLIENT_ID and PAYPAL_SECRET in .env.local, then restart the server.", 503);
    }
    const response = await request(`${PAYPAL_SANDBOX}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new PayPalDisputesError("PAYPAL_AUTH_FAILED", "PayPal could not authenticate the Sandbox app. Check the server credentials.", 502, response.headers.get("paypal-debug-id") ?? undefined);
    }
    let result: { access_token?: unknown; expires_in?: unknown };
    try { result = await response.json(); }
    catch { throw new PayPalDisputesError("PAYPAL_INVALID_RESPONSE", "PayPal returned an invalid authentication response.", 502); }
    if (!result || typeof result.access_token !== "string" || !result.access_token) {
      throw new PayPalDisputesError("PAYPAL_INVALID_RESPONSE", "PayPal returned an invalid authentication response.", 502);
    }
    const lifetime = Number(result.expires_in);
    cachedToken = {
      value: result.access_token,
      expiresAt: Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? Math.max(0, lifetime - 60) * 1000 : 0),
    };
    return cachedToken.value;
  }

  async function getToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
    if (!pendingToken) {
      pendingToken = fetchToken().finally(() => { pendingToken = undefined; });
    }
    return pendingToken;
  }

  async function get(path: string): Promise<unknown> {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await getToken();
        const response = await request(`${PAYPAL_SANDBOX}${path}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 401 && attempt === 0) {
          cachedToken = undefined;
          continue;
        }
        if (!response.ok) {
          const debugId = response.headers.get("paypal-debug-id") ?? undefined;
          if (response.status === 401) throw new PayPalDisputesError("PAYPAL_AUTH_FAILED", "PayPal rejected the refreshed access token.", 502, debugId);
          if (response.status === 404) throw new PayPalDisputesError("DISPUTE_NOT_FOUND", "This dispute was not found for the configured Sandbox merchant.", 404, debugId);
          if (response.status === 403) throw new PayPalDisputesError("PAYPAL_ACCESS_DENIED", "The Sandbox app or merchant does not have access to this dispute.", 403, debugId);
          if (response.status === 429) throw new PayPalDisputesError("PAYPAL_RATE_LIMITED", "PayPal is limiting requests. Wait a moment before refreshing.", 429, debugId);
          throw new PayPalDisputesError("PAYPAL_QUERY_FAILED", "PayPal could not return the dispute data. Try refreshing the case.", 502, debugId);
        }
        try { return await response.json(); }
        catch { throw new PayPalDisputesError("PAYPAL_INVALID_RESPONSE", "PayPal returned an invalid JSON response.", 502); }
      }
      throw new PayPalDisputesError("PAYPAL_AUTH_FAILED", "PayPal rejected the refreshed access token.", 502);
    } catch (error) {
      if (error instanceof PayPalDisputesError) throw error;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new PayPalDisputesError("PAYPAL_TIMEOUT", "The PayPal request timed out. Please try again.", 504);
      }
      throw new PayPalDisputesError("PAYPAL_UNAVAILABLE", "Unable to reach PayPal Sandbox. Please try again.", 502);
    }
  }

  return {
    async listDisputes() {
      const result = await get("/v1/customer/disputes");
      try { return normalizeDisputeList(result); }
      catch { throw new PayPalDisputesError("PAYPAL_INVALID_RESPONSE", "PayPal returned an invalid dispute list.", 502); }
    },
    async getDispute(id: string) {
      if (!/^[A-Za-z0-9-]{1,255}$/.test(id)) {
        throw new PayPalDisputesError("INVALID_DISPUTE_ID", "Enter a dispute ID containing only letters, numbers, and hyphens.", 400);
      }
      const result = await get(`/v1/customer/disputes/${encodeURIComponent(id)}`);
      try {
        const dispute = normalizeDisputeDetail(result);
        if (dispute.id !== id) throw new Error("Dispute ID mismatch.");
        return dispute;
      } catch { throw new PayPalDisputesError("PAYPAL_INVALID_RESPONSE", "PayPal returned an invalid dispute detail response.", 502); }
    },
    async provideEvidence(id: string, packet: { body: Uint8Array<ArrayBuffer>; contentType: string }) {
      if (!/^[A-Za-z0-9-]{1,255}$/.test(id)) throw new PayPalEvidenceError("INVALID_DISPUTE_ID", "Enter a valid dispute ID.", 400, "rejected");
      let token: string;
      try { token = await getToken(); }
      catch { throw new PayPalEvidenceError("PAYPAL_AUTH_FAILED", "PayPal could not authenticate the Sandbox app. No evidence request was sent.", 502, "rejected"); }
      let response: Response;
      try {
        response = await request(`${PAYPAL_SANDBOX}/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`, {
          method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60000),
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": packet.contentType }, body: packet.body,
        });
      } catch { throw new PayPalEvidenceError("EVIDENCE_OUTCOME_UNKNOWN", "The PayPal evidence request did not return a confirmed result. PayPal may have received it. Refresh the case and verify its evidence before any further submission.", 503, "unknown"); }
      const debugId = response.headers.get("paypal-debug-id") ?? undefined;
      if (response.status === 200) return { debugId: debugId ?? null };
      if (response.status === 401) cachedToken = undefined;
      if ([400, 401, 403, 404, 409, 413, 415, 422, 429].includes(response.status)) {
        const advice = response.status === 403 ? "Check Disputes API access and the update-seller permission."
          : response.status === 401 ? "Check the Sandbox credentials, then review the case again."
          : response.status === 429 ? "Wait before reviewing and submitting again."
          : "Refresh the case and check its requested evidence, references and file contents.";
        throw new PayPalEvidenceError("PAYPAL_EVIDENCE_REJECTED", `PayPal rejected the evidence (HTTP ${response.status}). ${advice}`, response.status === 401 || response.status === 403 ? 502 : response.status, "rejected", debugId);
      }
      throw new PayPalEvidenceError("EVIDENCE_OUTCOME_UNKNOWN", `PayPal returned HTTP ${response.status} without confirming the evidence submission. Verify the case in PayPal before any further submission.`, 503, "unknown", debugId);
    },
  };
}
