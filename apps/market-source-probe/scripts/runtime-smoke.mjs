import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
// Use the exact workerd runtime shipped with the workspace's pinned Wrangler.
const { Miniflare, convertV4MiniflareOptions } = createRequire(
  require.resolve("wrangler/package.json"),
)("miniflare");

test("bundled Worker makes bounded requests in workerd and never follows redirects", async () => {
  const now = Date.now();
  const calls = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: "dist/index.js",
    compatibilityDate: "2026-08-18",
    bindings: {
      DIAGNOSTIC_TOKEN: "runtime-test-token-not-a-production-secret",
      PROBE_ENABLED: "true",
      PROBE_STARTED_AT: String(now),
      PROBE_EXPIRES_AT: String(now + 60_000),
    },
    outboundService: async (request) => {
      assert.equal(request.headers.get("user-agent"), "DoDash-Market-Source-Probe/1.0");
      calls.push(request.url);
      return new Response(null, { status: 302, headers: { location: "https://untrusted.invalid" } });
    },
  }));
  try {
    const response = await runtime.dispatchFetch("https://probe/probe", {
      method: "POST",
      headers: { authorization: "Bearer runtime-test-token-not-a-production-secret" },
    });
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.phase, "completed");
    assert.equal(calls.length, 15);
    assert.ok(calls.every((url) => !url.includes("untrusted.invalid")));
    assert.ok(report.observations.every((row) => row.status === 302 && row.outcome === "HTTP_ERROR"));
  } finally {
    await runtime.dispose();
  }
});
