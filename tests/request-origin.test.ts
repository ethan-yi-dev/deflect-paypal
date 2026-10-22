import assert from "node:assert/strict";
import test from "node:test";
import { requireAssessmentOrigin } from "../lib/assessment/input";
import { isSameOriginRequest } from "../lib/request-origin";

const renderHeaders = {
  host: "deflect-demo.onrender.com",
  origin: "https://deflect-demo.onrender.com",
  "x-forwarded-proto": "https",
  "sec-fetch-site": "same-origin",
};
const proxied = (headers: Record<string, string> = {}) => new Request("http://localhost:10000/api/knowledge-base/documents", {
  method: "POST", headers: { ...renderHeaders, ...headers },
});

test("Render HTTPS uploads pass with an internal HTTP request URL", () => {
  assert.equal(isSameOriginRequest(proxied()), true);
  assert.doesNotThrow(() => requireAssessmentOrigin(proxied()));
});

test("the actual Host takes precedence over Next's canonical URL hostname", () => {
  const request = new Request("http://localhost:3107/upload", {
    method: "POST", headers: { host: "127.0.0.1:3107", origin: "http://127.0.0.1:3107" },
  });
  assert.equal(isSameOriginRequest(request), true);
});

test("direct local and HTTPS requests work without proxy headers", () => {
  for (const origin of ["http://localhost:3000", "http://127.0.0.1:3107", "http://[::1]:3000", "https://deflect.example"]) {
    assert.equal(isSameOriginRequest(new Request(`${origin}/upload`, { headers: { origin } })), true);
  }
});

test("custom domains and explicit public ports retain exact origin matching", () => {
  assert.equal(isSameOriginRequest(proxied({ host: "demo.example.com:8443", origin: "https://demo.example.com:8443" })), true);
  assert.equal(isSameOriginRequest(proxied({ host: "demo.example.com:8443", origin: "https://demo.example.com" })), false);
});

test("different origins, same-site sibling domains, null origins and HTTP downgrades fail", () => {
  for (const origin of ["https://unrelated.example", "https://other.onrender.com", "http://deflect-demo.onrender.com", "null", ""]) {
    assert.equal(isSameOriginRequest(proxied({ origin, "sec-fetch-site": "same-site" })), false);
  }
});

test("a cross-site browser request fails even with a matching or absent Origin", () => {
  const request = proxied({ "sec-fetch-site": "cross-site" });
  assert.equal(isSameOriginRequest(request), false);
  assert.throws(() => requireAssessmentOrigin(request), { code: "ORIGIN_NOT_ALLOWED", status: 403 });
  const withoutOrigin = new Request(request);
  withoutOrigin.headers.delete("origin");
  assert.equal(isSameOriginRequest(withoutOrigin), false);
});

test("forwarded host headers cannot authorize an unrelated browser origin", () => {
  assert.equal(isSameOriginRequest(proxied({ origin: "https://unrelated.example", "x-forwarded-host": "unrelated.example", forwarded: "host=unrelated.example;proto=https" })), false);
  // Even if Next built Request.url from an untrusted forwarded hostname, Host wins.
  assert.equal(isSameOriginRequest(new Request("https://unrelated.example/upload", {
    headers: { ...renderHeaders, origin: "https://unrelated.example", "x-forwarded-host": "unrelated.example" },
  })), false);
  assert.equal(isSameOriginRequest(proxied({ "x-forwarded-host": "unrelated.example" })), true);
});

test("invalid and ambiguous forwarded protocols fail closed", () => {
  for (const protocol of ["ftp", "https,http", "https, http", "", "https:"]) {
    assert.equal(isSameOriginRequest(proxied({ "x-forwarded-proto": protocol })), false);
  }
});

test("malformed request authorities cannot be interpreted as another site", () => {
  for (const host of ["", "deflect-demo.onrender.com@unrelated.example", "deflect-demo.onrender.com/path", "deflect-demo.onrender.com?x=1", "deflect-demo.onrender.com,unrelated.example", "deflect-demo.onrender.com:bad", "deflect-demo.onrender.com\\unrelated.example"]) {
    assert.equal(isSameOriginRequest(proxied({ host })), false);
  }
});

test("non-browser clients without Origin remain supported", () => {
  assert.equal(isSameOriginRequest(new Request("http://localhost:3000/upload", { method: "POST" })), true);
});
