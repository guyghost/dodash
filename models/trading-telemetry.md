# Trading telemetry model

Status: normative

Telemetry is an output signal only. It never selects a strategy, approves risk,
or changes an XState transition.

## Events

- `cycle.completed`: one record after a persisted interpreter run;
- `control.completed`: one record after stop, reset or kill reaches its observed
  outer state;
- `preflight.completed`: one record for every authenticated live-off preflight.

Every record contains a schema version, timestamp, Agent id, product, execution
mode, terminal phase/outcome, closed error code and latency. Cycle records also
contain daily PnL, account equity, position quantity, other exposure and whether
an exchange execution was observed. Preflight records contain only booleans,
reason code and open-order count; credentials, JWTs and balances are forbidden.

Cloudflare structured logs carry the full JSON record. Analytics Engine receives
a fixed positional projection documented in code and indexed by Agent id.
Telemetry write failures are logged but cannot make a trading transition; a
missing production binding is instead a deployment/preflight gate failure.

## Frozen alerts

- any `ORDER_OUTCOME_UNKNOWN`, `TERMINAL_FAILED`, kill failure or protection
  failure: page immediately;
- three reconciliation failures in 15 minutes: page;
- daily PnL at or below -1,000 USD, exposure above 20,000 USD, or drawdown above
  10%: page and invoke the operator kill runbook;
- no completed hourly live cycle for 120 minutes: page;
- health check failure for any Worker in two consecutive 5-minute probes: page;
- authentication failure rate above 10/minute: warn; above 50/minute: page.

Threshold changes require a new reviewed model and invalidate operations
evidence for the production-launch gate.

## Amendment 2026-09-19 (dao #47) — broker rejection detail in the Analytics
Engine projection

Finding (window #36): 496 `ORDER_REJECTED` cycles, 100% BTC-USD, but the
Analytics Engine projection only carried the terminal `WorkflowError` code
(blob6) — distinguishing `INSUFFICIENT_CASH` from `INSUFFICIENT_POSITION`
required a manual Durable Object read, deferring the anomaly diagnosis across
four analysis checkpoints.

Decision: records move to schema version 2 and the positional projection
gains **blob7 = broker rejection detail**. Rules:

- blob6 keeps carrying the closed `WorkflowError` code and is never
  overloaded;
- blob7 carries the closed execution-adapter vocabulary — paper:
  `packages/paper-execution` (`INSUFFICIENT_CASH`, `INSUFFICIENT_POSITION`,
  `INVALID_BROKER_CONFIG`, `INVALID_MARKET_PRICE`, `INVALID_FILL_RESULT`) —
  and only when blob6 is `ORDER_REJECTED`; `NONE` otherwise (including
  `control.completed` and `preflight.completed` records);
- the detail travels on the optional `WorkflowError.detail` diagnostic field
  (`models/trading-cycle.types.ts`) from the execution seam to the terminal
cycle event; it never drives a guard, transition or decision;
- no machine state, event or transition changes: telemetry only.

Verification contract: an `ORDER_REJECTED` cycle is diagnosable from a single
Analytics Engine query (`blob2`, `blob7`) with no Durable Object read.

## Amendment 2026-09-26 (DAO #62) — dated paper valuation and exposure quality

Paper cycle `accountEquity` is the value from `projectPaperValuation` using the
post-cycle portfolio and the last accepted, dated Coinbase candle close. It is
not the acquisition-cost equity returned by paper account reconciliation.
Each such record carries closed `valuationQuality` (`fresh`, `stale`,
`unavailable`), `valuationPriceSource`, `valuationPrice`, `valuationObservedAt`
and age. An unavailable mark yields null equity and price in the JSON log; AE's
numeric zero sentinel is accompanied by presence/quality fields and is never
read as an observed zero.

The measured `consolidatedExposureNotional` is distinct from
`otherExposureNotional`, which remains a risk-input field. For paper, publish
consolidated exposure from the portfolio projection with `exposureQuality`;
publish `otherExposureNotional=null` / unavailable while it still originates
from the paper stub. No new value flows into `checkRisk` or the orchestrator's
admission machine in this amendment. `dailyPnl` and its UTC window retain their
existing risk-policy source.

The record format advances to schema version 3. Analytics Engine appends its
new positional fields after existing positions; blobs 1–7 are preserved
exactly, including blob6's closed workflow error and blob7's closed broker
rejection detail. Appended blobs are blob8 `valuationQuality`, blob9
`valuationPriceSource`, blob10 `exposureQuality`. Appended doubles are
`valuationPrice`, `valuationObservedAt`, `valuationAgeMs`,
`consolidatedExposureNotional`, and presence bits for those nullable numbers.
Quality/source vocabularies are closed; no free text, secrets, account
identifiers or exchange-order identifiers are added.

## Invariants

1. No secret, bearer token, JWT, private key, raw request body or Coinbase
   credential appears in telemetry.
2. Every live cycle and control command emits at most one terminal event.
3. Telemetry never decides an order or state transition.
4. Production is `NO_GO` if the sink, queries or alerts are not verified.

## Amendment 2026-09-28 — `decision.missed` (paper campaign signal)

New event type `decision.missed`, schema version 3, same positional Analytics
Engine projection (blob1 = `decision.missed`, blob5 = `DECISION_WINDOW_MISSED`,
blob6 = last workflow error of the closing cycle or `NONE`). It is emitted at
most once per decision candle when a cycle completes after the freshness window
without a recorded decision for that candle (`models/cycle-schedule.md §3`).
All valuation fields are copied unchanged from the originating `cycle.completed`
event, including nulls and their presence bits. The missed candle close belongs
to the structured `decision_window_missed` log, never `valuationObservedAt`.
Frozen live alerts are unchanged; the operator notification class
`DECISION_WINDOW_MISSED` is documented in `operator-notifications.md`.
Supervision query (not implemented in the Durable Object): six or more
consecutive hourly cycles carrying `RATE_LIMITED` on one product.
