# Paper runtime release preparation — 2026-10-14

Local preparation passed. Nothing was deployed, pushed, collected from live exchanges, started/reset remotely, or written to managed secrets. Ordinary `deploy-workers` CI uses production configuration and must not publish this paper candidate.

## Runtime evidence

`cd apps/agent && npm run test:runtime` runs genuine `agents@0.21.0` TradingAgent in Miniflare 5/workerd 1.20260820.1 with SQLite Durable Objects. The subclass prepares fixture state, injects observation dates and persists emitted Analytics Engine points in a test-only SQLite table; it inherits scheduling, alarm dispatcher, effect adapters and interpreter. A separate fixture market Worker supplies candles/ticker. No fake Agent, scheduler, dispatcher or SQLite is used.

Assertions cover:
- Two-hour freshness at -1ms and exactly the threshold admits the candle at the injected evaluation timestamp; +1ms rejects with STALE_MARKET_DATA and no indicator/decision/order.
- Pending same-candle grid wake publishes two distinct cycle IDs and suppresses a duplicate decision. Expired pending retry followed by a new candle publishes a distinct admitted cycle, without DUPLICATE_ALARM.
- BTC retry leaves ETH runtime identical.
- Real SDK alarm dispatch of an early retry rearms; rearm=3 adds no schedule or machine effect. Orphan callback preserves state and telemetry.
- Positions remain intact, admission state and schema-v4 (20-double) telemetry survive disposal/restart using the same SQLite resource directory.

The bounded early dispatcher test explicitly invokes the genuine SDK `alarm()` after adding a due schedule; it does not wait for wall-clock alarm timing. This verifies dispatch behavior, not production clock accuracy. Test clock injection is restored after each request. Freshness uses the real interpreter and model guard.

## RED / GREEN

Initial RED identified test infrastructure traps: Miniflare5 legacy conversion with an absolute `scriptPath` produced opaque startup errors; inline bundled source resolves it. The converter silently ignores legacy `durableObjectsPersist`; native `resourcePersistencePath` supplies restart persistence. Browser-compatible bundling plus a real `node:module` require shim supports Tau-Prolog's CommonJS dependencies. An isolated newer workerd experiment was unnecessary; no repository runtime dependency changed.

Final runtime GREEN; baseline agent Vitest GREEN: 29 files, 313 tests. Workspace package TypeScript builds passed. Dashboard Vite/assets preparation passed. All four `wrangler.paper.jsonc` dry-runs passed (`agent`, `mcp-market-data`, `dashboard-api`, `dashboard`). Dashboard's initial dry-run failed because assets were absent; after its build it passed.

## Candidate artifact

`node scripts/paper-release-manifest.mjs NEW_BUNDLE_ROOT OUTPUT --prepare` writes a new immutable manifest (`wx`, never overwrites). It refuses tracked changes, untracked build inputs (apps/models/packages/scripts and root configuration), or existing bundle directories. Unrelated untracked analysis evidence is preserved and allowed. Bundle/output paths are resolved absolutely before child builds. It rebuilds workspace packages and dashboard assets and runs all four paper dry-runs. It binds build provenance to exact tracked input bytes and git SHA, checks expected entry bundles, and rejects missing/stale provenance or mismatched bundle bytes. Admission clocks persist in the real SDK state table; cycle artifacts retain candle/trigger clocks. A zero-call external-network guard prevents fixture runs contacting live endpoints.

It records git SHA, SHA256 of exact paper configuration bytes and each dry-run bundle, paper service/dataset names, disabled live/perp flags and the managed-secret preservation constraint. Keep this manifest alongside the candidate bundles. Rebuild/re-fingerprint after any source change; this preparation does not authorize deployment.

Local logs and artifacts are under `/private/tmp/dodash-paper-*`. Physical exchange/network behavior, deployed Workers, remote Analytics Engine ingestion, remote alarms and managed-secret inventory were not verified. Local fixture capture proves the real telemetry sink projection/persistence contract, not Analytics Engine remote delivery.
