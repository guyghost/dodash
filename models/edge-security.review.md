# Edge security model review

Reviewed: 2026-08-24

Decision: approved for implementation, subject to deployment-time namespace
verification.

## Nominal cases

- Exact `/api` and descendant routes are limited, then forwarded unchanged.
- `GET /health` returns the constant health JSON without limiter or binding
  use; non-GET `/health` falls through to asset serving.
- Static and SPA routes are served without touching the API limiter.
- All public responses receive the same minimum headers.

## Errors and retries

- Digest or limiter failures return 503 before the private service is called.
- A quota denial returns 429 and declares a 60-second retry interval.
- Binding fetch failures are not silently converted into success or retried.
- There is no server-side retry that could double-submit a mutating API call.

## Cancellation

Request cancellation is owned by the Workers runtime and propagates through the
binding fetch. There is no persistent workflow state to repair.

## Permissions and trust boundaries

- The edge limiter reduces abuse; it does not grant access.
- Authentication and same-origin authorization remain in the private API.
- Hashing prevents disclosure of bearer material to the limiter key space.
- The credential bucket groups repeated uses of the same credential. The
  independent Cloudflare-source bucket bounds rotated invalid credentials;
  caller-supplied forwarding headers never select it.

## Terminal behavior

Every classified request either returns one decorated response, returns a
decorated 429/503, or terminates with a runtime transport error. No implicit
transition exists after a terminal response.

## Trade-offs accepted

- The limit is intentionally coarse: 100 requests per source and per credential
  per minute. Only address digests enter the limiter, not raw client IP storage.
- A stolen credential shares its legitimate owner's quota. This is safer than
  allowing unbounded use and does not weaken authentication.
- The CSP is deliberately strict and may require an explicit model update if
  future dashboard assets use external origins or inline scripts.

## Deployment hold

Cloudflare requires a rate-limit namespace ID to be unique within the account.
The repository can define the binding, but production remains fail-closed until
the deploy operator confirms the selected ID does not collide with another
binding in the target account.

## Configuration drift observed

The 2026-08-23 deployment served the SPA shell for `/health` because the assets
`run_worker_first` list omitted `/health`; `wrangler deploy` succeeded, so only
an external response-body check could detect the unreachable
`respondingHealth` transition. The configuration invariant now pins the
required routing prefixes, and the deploy smoke test asserts the JSON body
rather than a bare 200.
