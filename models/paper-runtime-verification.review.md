# Paper runtime verification review

Model review pending root approval before implementation.

The contract adds verification tooling only, with state transitions delegated to existing XState models. Fixture I/O and a test adapter are permissible imperative boundaries. SDK dispatch/scheduling and SQLite cannot be mocked. Restart evidence must reuse persistent storage. Local release preparation cannot authorize deployment or production CI. Each required invariant needs an observable assertion, with limits reported honestly.

Root approved 2026-10-14. Freshness is tradingCycle isFreshMarketData at evaluatedAt against candleClosedAt, configured maxMarketStalenessMs=7_200_000; test -1/exact/+1ms boundaries. Test-only injected clock and persisted fixture states allowed; use real interpreter, SDK dispatcher and SQLite.

Root approved static asset amendment on 2026-10-14 following independent P2 review. Include immutable candidate asset snapshot and exact source-tree comparison; preserve paper config and managed secrets. This corrects release evidence only and adds no trading transition.

Root approved complete bundle provenance amendment on 2026-10-15 after PR #25 review: compare exact payload paths and hashes, keep exemptions restricted to root metadata/log, reject duplicate and unsafe provenance paths. This tightens release evidence without changing trading state or authorizing deployment.
