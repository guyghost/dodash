export interface DashboardEdgeEnv {
  readonly ASSETS: Fetcher;
  readonly DASHBOARD_API: Fetcher;
  readonly AUTH_RATE_LIMITER: {
    limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
  };
}

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'";

const withSecurityHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const unavailableResponse = (): Response =>
  withSecurityHeaders(new Response("Service unavailable", { status: 503 }));

export const handleDashboardEdgeRequest = async (
  request: Request,
  env: DashboardEdgeEnv,
): Promise<Response> => {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/health" && request.method === "GET") {
    return withSecurityHeaders(
      Response.json(
        { status: "ok", service: "dodash-dashboard" },
        { headers: { "cache-control": "no-store" } },
      ),
    );
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    try {
      const credential = request.headers.get("authorization") ?? "anonymous";
      const source = request.headers.get("cf-connecting-ip") ?? "unknown-source";
      const [sourceFingerprint, credentialFingerprint] = await Promise.all([
        sha256Hex(source),
        sha256Hex(credential),
      ]);
      const sourceLimit = await env.AUTH_RATE_LIMITER.limit({
        key: `dashboard-api:source:${sourceFingerprint}`,
      });
      if (!sourceLimit.success) {
        return withSecurityHeaders(
          new Response("Too many requests", {
            headers: { "Retry-After": "60" },
            status: 429,
          }),
        );
      }
      const credentialLimit = await env.AUTH_RATE_LIMITER.limit({
        key: `dashboard-api:credential:${credentialFingerprint}`,
      });
      if (!credentialLimit.success) {
        return withSecurityHeaders(
          new Response("Too many requests", {
            headers: { "Retry-After": "60" },
            status: 429,
          }),
        );
      }
    } catch {
      return unavailableResponse();
    }
    return withSecurityHeaders(await env.DASHBOARD_API.fetch(request));
  }
  return withSecurityHeaders(await env.ASSETS.fetch(request));
};

export default {
  fetch: handleDashboardEdgeRequest,
} satisfies ExportedHandler<DashboardEdgeEnv>;
