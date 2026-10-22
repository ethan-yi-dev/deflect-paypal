/** Compare the browser origin with the public request authority behind TLS proxies. */
export function isSameOriginRequest(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  // Preserve non-browser clients that do not send an Origin header.
  if (origin === null) return true;

  try {
    const url = new URL(request.url);
    // Next can canonicalize Request.url to an internal hostname. Host still
    // identifies the requested site; do not trust an arbitrary forwarded host.
    const host = request.headers.get("host") ?? url.host;
    if (!host || /[\s,/@?#\\]/.test(host)) return false;
    // Render terminates TLS before forwarding HTTP to Next. Only accept one
    // valid protocol value, rather than guessing from Origin or a header list.
    const protocol = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
    if (protocol !== "http" && protocol !== "https") return false;
    return origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}
