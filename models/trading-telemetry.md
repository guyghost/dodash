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

## Invariants

1. No secret, bearer token, JWT, private key, raw request body or Coinbase
   credential appears in telemetry.
2. Every live cycle and control command emits at most one terminal event.
3. Telemetry never decides an order or state transition.
4. Production is `NO_GO` if the sink, queries or alerts are not verified.
