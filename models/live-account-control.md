# Live account control model

Status: normative

This model owns the Coinbase account facts used by the live risk decision and
the destructive control path used by the kill switch. It complements the
trading-cycle machine; it does not generate signals or choose trades.

## Trusted inputs

The live adapter reads the Coinbase Advanced Trade portfolio that is explicitly
bound to the API key by `COINBASE_PORTFOLIO_ID`. It uses:

- `GET /api/v3/brokerage/portfolios/{portfolio_uuid}?currency=USD` for total
  equity, available cash, target position, average entry price and all other
  exposure;
- `GET /api/v3/brokerage/orders/historical/batch` for product orders;
- `POST /api/v3/brokerage/orders/batch_cancel` for cancellation;
- `POST /api/v3/brokerage/orders` and order reconciliation for flattening and
  protective orders.

Every response is bounded, schema-validated and matched to the configured
portfolio/product. Missing, stale, ambiguous or non-finite data is an error,
never zero exposure.

The configured portfolio/product pair is operationally exclusive to this
system: no manual order and no second bot may trade the same product in that
portfolio. A live preflight must prove that every open product order is either a
protective order persisted by this Agent or the current idempotent intent.
Discovery of an unknown order is account drift and enters the terminal safety
path; it is never silently adopted.

## Pre-decision reconciliation

The trading-cycle transition becomes:

`waiting → reconcilingAccount → fetchingMarketData`.

`ACCOUNT_RECONCILED` carries a typed snapshot ID and causes the interpreter to
replace the local live portfolio before allocation and risk. A retryable error
uses the bounded reconciliation budget. Exhaustion persists `FAILED`; it never
continues with the previous snapshot.

A valid snapshot contains:

- target base quantity including held quantity;
- target base quantity available to sell;
- quote cash available to trade;
- target average entry price;
- total account equity in USD;
- target exposure in USD;
- `otherExposureNotional = max(0, totalEquity - quoteCashTotal -
  targetExposure)`;
- observation time and portfolio UUID.

The daily UTC risk window is resolved from `totalEquity` at the reconciliation
observation time. It is therefore evaluated on every scheduled live cycle, even
when the ONE_DAY decision candle is a duplicate.

## Live-off preflight

`assessLivePreflight` is the fail-closed admission model for production
credentials. It is read-only and can pass only while `LIVE_TRADING_ENABLED` is
not true. The collected evidence must prove:

- credentials and the explicit portfolio UUID are configured;
- the production telemetry binding is present;
- the key has `view` and `trade`, has no `transfer`, and Coinbase reports the
  same portfolio UUID;
- the product is in the live allowlist and its increments are valid;
- the portfolio breakdown reconciles successfully;
- every open product order belongs to the Agent's persisted protection set.

The first false fact produces a closed reason code. The preflight neither
starts an Agent nor submits, previews, cancels or edits an order.

## Kill switch machine

The important kill workflow is represented by `liveAccountControlMachine`.

### States

- `idle`
- `cancellingOrders`
- `retryingCancellation`
- `reconcilingPosition`
- `retryingReconciliation`
- `flatteningPosition`
- `verifyingFlat`
- `retryingVerification`
- `completed` (terminal)
- `failed` (terminal)

### Events and transitions

| State | Event / guard | Next | Effect represented |
| --- | --- | --- | --- |
| `idle` | `KILL_REQUESTED` with control permission | `cancellingOrders` | Freeze one product and deterministic flatten client ID prefix. |
| `idle` | request without permission | `failed` | Record `CONTROL_PERMISSION_REQUIRED`. |
| `cancellingOrders` | `ORDERS_CLEARED` | `reconcilingPosition` | All open product orders have been listed, cancelled and re-listed as zero. |
| cancellation | retryable `OPERATION_FAILED` within budget | `retryingCancellation` | Record attempt/error. |
| cancellation | permanent/exhausted failure | `failed` | No flatten is submitted while executable quantity is ambiguous. |
| `reconcilingPosition` | `ACCOUNT_RECONCILED`, open orders > 0 | `cancellingOrders` | Close cancellation/reconciliation race. |
| reconciliation | total base ≤ dust and open orders = 0 | `completed` | Already flat. |
| reconciliation | total base > dust and all non-dust base is available | `flatteningPosition` | Store reconciled quantity. |
| reconciliation | held/ambiguous quantity remains | `retryingReconciliation` or `failed` | Wait boundedly for holds to clear. |
| `flatteningPosition` | `FLATTEN_CONFIRMED` or `FLATTEN_OUTCOME_UNKNOWN` | `verifyingFlat` | Reconcile; never blindly infer a fill. |
| flattening | certain rejection within budget | `reconcilingPosition` | A new attempt is allowed only after a new account snapshot. |
| flattening | permanent/exhausted failure | `failed` | Preserve evidence and remain non-halted. |
| `verifyingFlat` | zero orders and base ≤ dust | `completed` | Terminal success. |
| verification | any remaining orders | `cancellingOrders` | Cancel before another flatten decision. |
| verification | remaining available base within budget | `flatteningPosition` | Increment sequence and sell only reconciled residual. |
| verification | held/ambiguous base | `retryingVerification` or `failed` | Bounded retry. |

Retry timer events only re-enter the phase that failed. No adapter error string
chooses a transition.

## Protective order lifecycle

1. Every live BUY includes an attached `trigger_bracket_gtc` using the exact
   approved stop-loss and take-profit prices.
2. A BUY is not terminally confirmed until the filled parent exposes a non-empty
   `attached_order_id` and that order is reconciled as open for the same product.
3. Before a directional SELL, every protective order owned by this agent/product
   is cancelled and confirmed absent.
4. A residual position after SELL is re-armed with one bracket for the residual.
5. If protection cannot be confirmed after a fill, the kill machine is invoked;
   success means flat, failure means terminal `failed`, never normal scheduling.

### Directional SELL machine

`liveSellProtectionMachine` owns the protection gap around a strategy SELL. Its
normal path is:

`idle → cancellingProtections → reconcilingBeforeSell → submittingSell →
reconcilingSell → reconcilingResidual → (completed | armingResidual →
confirmingResidualProtection → completed)`.

The machine receives only typed exchange facts. Before submission it requires a
fresh account snapshot proving that the requested quantity still exists, is
available and is not held. A protection that fills during cancellation can
therefore produce `NO_SELL_NEEDED`; a partial race never changes the persisted
order quantity or reuses its idempotency key with a different payload.

After the SELL is confirmed, a fresh account snapshot decides the only two
normal terminal cases:

- base at or below dust: `SOLD_FLAT`;
- a fully available residual with a positive average entry: create and confirm
  exactly one residual long bracket, then `SOLD_REPROTECTED`.

Any ambiguous account, rejection, unconfirmed outcome, protection creation or
confirmation failure enters `safetyFlattening`. That state delegates to
`liveAccountControlMachine`; successful flattening ends `safetyCompleted` with
`FLATTENED_AFTER_FAILURE`, which the outer trading cycle records as the terminal
`ORDER_PROTECTION_FAILED`. A failed flatten ends `failed`. Neither safety
terminal is a normal confirmed SELL.

## Invariants

1. No live allocation or risk decision consumes configured `initialCapital` or
   a previous local position as an account fact.
2. `otherExposureNotional` is never hard-coded to zero in live mode.
3. `halted` after a kill is reachable only after kill-machine `completed`.
4. Kill success means zero open product orders and base quantity at or below the
   configured base increment (dust tolerance).
5. A flatten order uses the currently reconciled available base quantity and a
   deterministic client order ID scoped to the control request, fresh account
   snapshot and attempt.
6. Unknown submission outcome transitions to verification/reconciliation, not a
   duplicate blind submission.
7. The kill switch cancels the schedule before exchange mutation and never
   recreates it.
8. Every non-dust live position is protected at a terminal normal-cycle state;
   otherwise the account is flattened or the agent is terminally failed.
9. Reset never clears exchange facts. A fresh reconciliation is mandatory before
   a later start.
10. If an unknown flatten outcome still leaves a non-dust balance, the workflow
    fails terminally; it never creates a second client order ID for an unresolved
    first submission. A new residual attempt is allowed only after a confirmed
    terminal fill.
    After process recovery, a new ID is permitted only after open orders were
    cancelled/confirmed and a new account snapshot proves the terminal residual.
11. A directional SELL never changes its persisted quantity after protective
    cancellation; an account race is flattened instead.
12. A normal SELL terminal has either no non-dust base or exactly one confirmed
    residual protective bracket.
13. Production admission requires exclusive ownership of each
    portfolio/product pair; unknown open orders fail the preflight and the
    active safety path.
14. A kill requested while an order is possibly in flight first reconciles that
    idempotent intent, persists its outcome, then executes the kill machine.
    `halted` requires `killCompleted=true`; a request flag alone is insufficient.
