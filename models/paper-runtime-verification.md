# Paper runtime verification contract

## Scope
Verification and release preparation only. No deployment, live collection, agent start/reset against remote systems, secret mutation or push. Existing source models remain authoritative: cycle-schedule, market-retry-schedule, cycle-wake and admission telemetry contracts. This harness introduces no trading decision or transition.

## Runtime boundary
Instantiate the genuine Agents SDK TradingAgent in Miniflare/workerd with SQLite Durable Object persistence. A test-only subclass may prepare persisted state/artifacts, control observation dates and capture telemetry. It must never replace Agent, scheduling, alarm dispatcher, SQLite, or trading interpreter. Market data comes from a deterministic fixture service, never a live exchange. Restart the runtime using the same persistence directory and verify rehydration.

## Events and invariants
- Freshness observation immediately before, exactly at, and after two hours must obey existing freshness comparison; preserve portfolio positions throughout.
- A BTC retry callback changes only the targeted BTC runtime; ETH runtime remains identical.
- Grid wake while retry pending finalizes the old cycle then issues a distinct new cycle. Same closed candle emits no duplicate decision; a new candle is admitted. Neither case produces DUPLICATE_ALARM.
- Early retry callback rearms once within its bounded deadline using genuine SDK scheduling; orphan callback has no cycle/state effects.
- Admission telemetry schema v4, timestamps and decision candle identity survive artifact/state SQLite persistence and runtime restart.
- All effects use paper execution; LIVE_TRADING_ENABLED and HYPERLIQUID_PERP_TRADING_ENABLED remain false.

## Release artifact
Dry-run every wrangler.paper.jsonc. Record immutable git SHA, configuration hash and bundle hashes in a paper-only manifest. Assert paper worker/service/dataset names and both trading flags. Preserve managed secrets; ordinary production CI config is outside scope.

## Verification outcomes
A runtime assertion is evidence only when run under workerd with genuine SDK/SQLite. Shell tests are supplementary evidence. Failures and missing dependencies must remain explicit; no mock may masquerade as runtime verification.

## Static asset amendment (approved by root)
Dashboard client HTML/JS/CSS are release payloads alongside Worker bundles. Preparation snapshots the exact nonempty paper-config asset directory (including index.html), fingerprints relative paths and bytes, and binds snapshot/source directory to the paper config hash. Revalidation rejects snapshot mutations, additions or omissions and current generated-source drift, because unchanged paper config still references the current dist/client directory. No deployment is authorized.

## Complete bundle provenance amendment
Revalidation requires the complete candidate payload tree to match provenance.outputs by canonical relative path and SHA-256. Added, missing, duplicated or altered payload entries reject the candidate. Only the root paper-build-provenance.json metadata and root wrangler.log are outside this payload tree; nested files with those basenames are payloads. Asset snapshots remain both bundle payloads and independently validated asset evidence.
