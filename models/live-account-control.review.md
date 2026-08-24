# Live account control review

Reviewed: 2026-08-23

Decision: approved for staged implementation and sandbox/fake-exchange
verification. Production remains forbidden until the complete adapter and
preflight evidence satisfy this model.

## Nominal paths

- Flat kill: cancel/confirm orders, reconcile zero, complete without an order.
- Invested kill: cancel/confirm, reconcile available base, flatten, verify zero.
- Daily risk: account equity is refreshed before every decision, including
  duplicate daily candles.
- BUY: parent fill and attached protection are both reconciled.
- SELL: owned protection is removed before sale and residual protection is
  confirmed afterward.
- SELL race: a flat account becomes `NO_SELL_NEEDED`; a partial quantity change
  enters safety flatten rather than mutating an idempotent order payload.

## Errors and retries

- Network, rate limit and 5xx errors are retryable only within explicit phase
  budgets.
- Invalid schema, portfolio mismatch, negative/non-finite values and permanent
  4xx responses are terminal.
- Unknown flatten outcome always enters verification.
- Any SELL failure after protection cancellation enters the kill machine; it
  cannot resume normal scheduling with an unprotected residual.
- A held balance retries reconciliation; it is never treated as sellable or flat.
- Exhausted kill work ends `failed`; the outer trading machine must not report
  `halted`.

## Cancellation

The kill workflow itself cannot be cancelled by stop/reset. Worker termination
is recovered by persisted outer state plus idempotent Coinbase client IDs and a
fresh exchange reconciliation.

## Permissions

Control permission is checked before entering the kill workflow. Coinbase view
and trade permissions are both required by preflight. Authentication failure is
terminal and never downgraded to an empty account.

The operator must also attest exclusive ownership of every configured
portfolio/product pair. Preflight discovery of a manual or foreign order is a
hard failure; shared-product operation is outside the reviewed model.

The preflight additionally rejects transfer-capable keys: production trading
needs `view` and `trade`, not withdrawal authority. It is valid only with live
execution disabled and performs authenticated reads exclusively.

## Terminal states

- `completed` proves the flat/open-order invariants from a fresh snapshot.
- `failed` retains stage, error code and attempts for operator recovery.
- `safetyCompleted` proves flat after a SELL protection failure but remains an
  outer terminal failure, not an order success.
- There is no automatic transition out of either terminal state.

## Review findings to verify

- Test every allowed transition and representative forbidden events.
- Prove no order is sent when account schema, portfolio or quantities disagree.
- Prove unknown outcomes do not duplicate a quantity.
- Prove crash recovery uses a new snapshot-scoped id only after the prior order
  is terminally cancelled and the residual is freshly reconciled.
- Prove protective price serialization follows product increments.
- Prove the trading-cycle `EFFECT_CANCEL_FAILED` path cannot reach `halted`.
- Prove a kill during submission/reconciliation cannot reach `halted` before
  the in-flight order is reconciled and the kill machine completes.
- Prove a persisted snapshot created before the account-control fields existed
  restores them to explicit fail-closed defaults before any transition.
- Run Coinbase's static sandbox contract tests, then a live-off preflight with
  view permission before any canary funding.
