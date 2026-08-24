# Live trading operations runbook

Status: required for production evidence

## Ownership

- On-call owner: **UNASSIGNED — production gate must remain NO_GO**
- Release operator: GitHub `production` environment approver
- Incident channel: **UNASSIGNED**

Replace both unassigned fields with accountable, reachable identities before
submitting `OperationsEvidence`. A repository role without a real rota is not
sufficient evidence.

## Immutable scope

- policy: `CONFIDENCE_POWER_THIRD_2026_08`
- products: `GRT-USD`, `MANA-USD`, `XTZ-USD`, `ZEC-USD`
- initial canary: one product only
- release: exact 40-character Git SHA supplied to the deploy workflow

## Deploy live OFF

1. Confirm the release SHA passed `verify:push` in a clean GitHub runner.
2. Dispatch `ci` with `deploy_workers=true` and the exact `release_sha`.
3. The protected production job sets `LIVE_TRADING_ENABLED=false` before the
   Agent Worker deployment.
4. The job deploys market data, Agent, dashboard API and dashboard, then probes
   their four configured HTTPS health URLs.
5. Run the authenticated Agent `/preflight` for all four live products. Every
   report must be `APPROVED`; retain the timestamped JSON as release evidence.
6. Verify Analytics Engine received `preflight.completed` for each Agent and
   Cloudflare logs contain no `telemetry.write_failed`.

No step in this deployment workflow enables live trading.

## Canary activation checklist

Activation is a separate, approved operator action after the first four launch
gates and shadow evidence pass.

1. Freeze one canary product, loss budget and rollback thresholds.
2. Confirm a human observer and on-call owner are present.
3. Exercise kill with a zero-funded/dust account and retain the reconciled-flat
   response.
4. Set `LIVE_TRADING_ENABLED=true` for the Agent Worker.
5. Start only the canonical canary Agent (`<product>--multi`).
6. Observe every cycle, order, protection and account reconciliation for at
   least 48 hours. Do not enable another product during this window.

## Immediate rollback triggers

- any unresolved `ORDER_OUTCOME_UNKNOWN` or duplicate client order;
- any `TERMINAL_FAILED`, protection mismatch or kill failure;
- account position different from Agent reconciliation;
- daily PnL at or below -1,000 USD;
- gross exposure above 20,000 USD;
- drawdown above 10%;
- three reconciliation failures within 15 minutes;
- no completed hourly live cycle for 120 minutes;
- two consecutive health probe failures.

## Kill and disable procedure

1. Call `POST /api/agents/<canonical-name>/kill` with the control token.
2. Require the response state to be `halted`; any other state is an incident.
3. Confirm Coinbase shows zero open product orders and base at or below dust.
4. Set `LIVE_TRADING_ENABLED=false` immediately, even if kill succeeded.
5. Preserve the Agent cycle rows, structured logs, Analytics Engine window,
   Coinbase order/fill IDs and the exact release SHA.

Never reset or restart an Agent until the exchange facts are reconciled and the
incident owner approves recovery.

## Code rollback

1. Keep live disabled.
2. In Cloudflare, roll back each Worker to the previously recorded version, or
   redeploy the last approved Git SHA through the protected workflow.
3. Re-run all four health checks and every product preflight with live OFF.
4. Verify Durable Object state and SQLite cycle/order rows remain readable.
5. Record start/end timestamps. The operations gate requires a rehearsed,
   measured rollback; target recovery time is 15 minutes.

Code rollback never substitutes for exchange kill/flat verification.

## Analytics Engine mapping

Dataset: `dodash_trading`; index: Agent id.

- blobs: event type, product, mode, phase, outcome, error code;
- doubles: timestamp, latency, daily PnL, account equity, position quantity,
  other exposure, execution-observed flag, open-order count, PnL-present flag,
  equity-present flag.

Create Cloudflare notifications matching the frozen thresholds in
`models/trading-telemetry.md`. Retain screenshots or API exports of destinations,
queries and enabled state as operations evidence.
