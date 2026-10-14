# P7 collector — local preparation

One campaign per actual SQLite Durable Object, with a transactional journal,
materialized projection, request checkpoints, fixed checkpoint snapshots and
R2 outbox. This package runs local synthetic simulations only. Its manifest
remains `LOCAL_PREPARATION`; every journal/export/report retains
`SYNTHETIC_LOCAL_PREPARATION`. Prospective economic collection is not shipped:
`/start` always rejects, including when `PROSPECTIVE_ENABLED` is changed.

## Local verification

From the repository, build `@dodash/domain`, `@dodash/paper-execution` and
`@dodash/risk`, then in this directory run:

```
npm run check
npm run build
npm test
```

Tests bundle the current source with esbuild and use Miniflare/workerd's real
SQLite, real R2 and alarm callbacks. They use temporary persistent directories
and explicitly inject a fixture service. Local loopback sockets are necessary.
The source service is the only fake dependency; DO storage is not mocked.
The R2 failure test delegates to real R2, then fails acknowledgement deliberately.
No remote resource, migration, deploy, source call or campaign start is performed.

## Contract

`models/p7-shadow-runner.md` and its reviewed pure implementation own decisions.
Registration freezes local manifest, benchmark precision, risk configuration,
code/protocol fingerprints. HTTP paths are `/campaigns/{campaignId}/register`,
`preflight`, `wake`, `status`, `export`, `assess`, `alarm`, `stop`, `start`.
The default configuration refuses local operations; tests explicitly supply
`LOCAL_FIXTURES_ENABLED=true` and `FIXTURE_SOURCE`. No arbitrary URL is accepted.
Registration must match the route identity. These fixture APIs are not a remote
operator authentication system and must not be published as one.

A local `wake {at}` advances the persisted virtual clock; elapsed wall time then
advances it during I/O and across restarts. Alarms use that mapping and persist
next wake times. Each wake processes at most 32 jobs and each export at most 64
rows. Catchup re-arms alarms. Daily history must contain exactly 240 contiguous
causal closes. P7 uses target-exposure, risk, depth pricing and paper broker
models; B&H initializes independently. Marks share common source evidence.
After-fill marks run before further P7 pricing, after the two-leg B&H bootstrap.
FINAL fetches before T1 and commits at T1; captured evidence survives restart.

Every external request has a durable REQUEST before I/O. The 5-second timeout
records missing evidence; an interrupted unknown response suspends on reboot
and is never refetched. Raw response bytes and their SHA-256 are journaled along
with the normalized parsed evidence. I/O is outside transactions. Economic and
safety gates run again inside the commit transaction with a fresh use clock.
Journal+projection+outbox writes roll back together. Journal UPDATE/DELETE is
blocked by SQL triggers. Boot verifies sequence/hash chain and current projection
hash; export verifies exact journal bytes. Projection/checkpoint bodies are
chunked below SQLite per-row limits.

R2 keys are `p7-shadow/v1/{campaignId}/{sequence}-{sha256}.json`; retries publish
identical bytes. The journal chain and R2 are not an independent immutable
anchor. Export failure retains the outbox. Checkpoints J30/J90/J180 freeze the
projection and sequence/hash at the cutoff, and reports are journaled/exported.
Later trades or safety changes cannot alter the frozen J30/J90 inputs.

## Evidence limits

The suite covers persistent restart, unknown-request crash, idempotence,
independent B&H on HOLD, P7 BUY and after-fill ordering, timeout, actual alarms,
R2 write/ack failure, immutable identity, FINAL/T1, frozen J30 and default denial.
Pure tests enumerate the complete 180-day inventory in bounded pages.
A complete 180-day economic simulation under workerd has not been load-tested.
Materialized projection validation still reads the complete campaign projection;
chunking avoids SQLite row-size limits but is not evidence of CPU/latency budget
at full retention. No prospective source qualification, auth, deployment,
provider cost/performance validation or real market collection is claimed.

Official API references consulted:
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/

Capture budgets are 1 MiB UTF-8 raw and 256 KiB normalized JSON. Raw evidence is
content-addressed in bounded SQLite chunks; journal rows contain compact
references. R2 exports capture chunks before journal references. Oversized
responses stop reading at the byte budget and retain a bounded rejection,
observed byte count (a lower bound), and explicitly labeled bounded-prefix
SHA-256. A whole-body hash is recorded only after complete body consumption.
The shared five-second deadline includes both response headers and streaming
body consumption. Normalized
responses are hash-checked before reuse.

An interruption after admission but before a durable decision suspends with
`ADMITTED_DECISION_UNRESOLVED`; it never fabricates HOLD or refetches candles.
Expired/suspended incomplete daily jobs receive an unresolved scheduler receipt
while preserving their nonterminal ledger evidence for the assessment. They do
not retry a past deadline or block subsequent diagnostic jobs/checkpoints.
