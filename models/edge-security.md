# Edge security model

Status: normative

The public dashboard Worker is the only internet-facing entry point. It serves
static assets and proxies `/api` requests to the private dashboard API service.
This model defines the security decision made before either response leaves the
public boundary.

## Inputs

- `request`: the incoming HTTP request.
- `AUTH_RATE_LIMITER`: a Cloudflare Rate Limiting binding configured for
  100 requests per 60 seconds.
- `DASHBOARD_API`: the private dashboard API service binding.
- `ASSETS`: the static asset binding.

## Classification

- `API_REQUEST`: the path is exactly `/api` or starts with `/api/`.
- `ASSET_REQUEST`: every other path, including names such as
  `/api-client.js`.

Classification depends only on the parsed pathname. Free-form request content
and LLM output never select a transition.

## States and transitions

| State | Event / condition | Next state | Effect |
| --- | --- | --- | --- |
| `classifying` | `ASSET_REQUEST` | `fetchingAsset` | Fetch from `ASSETS` without consuming API quota. |
| `classifying` | `API_REQUEST` | `derivingRateLimitKey` | Read the Authorization header, or the literal `anonymous` when absent. |
| `derivingRateLimitKey` | SHA-256 succeeds | `checkingRateLimit` | Use `dashboard-api:<hex digest>` as the limiter key. |
| `derivingRateLimitKey` | digest fails | `serviceUnavailable` | Return 503; do not call the private service. |
| `checkingRateLimit` | limiter returns `success: true` | `fetchingApi` | Forward the original request unchanged to `DASHBOARD_API`. |
| `checkingRateLimit` | limiter returns `success: false` | `rateLimited` | Return 429 with `Retry-After: 60`. |
| `checkingRateLimit` | limiter throws/rejects | `serviceUnavailable` | Return 503; do not call the private service. |
| `fetchingAsset` | binding resolves | `responding` | Decorate the response with the public security headers. |
| `fetchingApi` | binding resolves | `responding` | Decorate the response with the public security headers. |
| either fetch | binding throws/rejects | terminal error | Preserve the runtime error; Cloudflare owns transport failure handling. |

`responding`, `rateLimited`, and `serviceUnavailable` are terminal for one
request.

## Public response headers

Every response created or returned by the public Worker has:

- `Content-Security-Policy: default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'`
- `Referrer-Policy: no-referrer`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Permissions-Policy: camera=(), geolocation=(), microphone=()`

The Worker clones upstream response metadata before adding headers. It never
mutates a binding-owned response object in place.

## Invariants

1. The raw Authorization value is never a limiter key, response value, or log
   value; only its SHA-256 digest crosses the limiter boundary.
2. An API request reaches `DASHBOARD_API` only after an explicit successful
   rate-limit decision.
3. A missing or failed limiter fails closed with 503.
4. Asset traffic never consumes authenticated API quota.
5. Rate limiting is not authentication. The private dashboard API remains the
   sole owner of constant-time credential validation and same-origin checks.
6. No permissive CORS header is added at the public boundary.
7. Security headers apply to successful, rejected, and service-unavailable
   responses.
8. Retry is client-driven. The Worker performs no implicit retry after a denial
   or limiter failure.

## Configuration invariant

The `AUTH_RATE_LIMITER` namespace ID is a positive integer string reserved for
this application in the target Cloudflare account. Its simple limit is 100
requests per 60 seconds. Production deployment is forbidden until the namespace
is confirmed unique in that account.
