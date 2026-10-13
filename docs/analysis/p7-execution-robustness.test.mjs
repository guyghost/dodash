import assert from "node:assert/strict";
import { test } from "node:test";
import { replayP7Scenario, validateP7Datasets } from "./p7-execution-robustness-core.mjs";

const DAY = 86_400_000;
const start = Date.UTC(2025, 0, 6) - 239 * DAY;
const history = (extra = false, open = 110) => ({
  "BTC-USD": [...Array.from({ length: 240 }, (_, i) => ({ start: start + i * DAY, open: 100, close: i === 239 ? 110 : 100 })),
    ...(extra ? [{ start: start + 240 * DAY, open, close: 112 }] : [])],
  "ETH-USD": [],
});
const scenario = { id: "O0", execution: "NEXT_OPEN", feeBps: 60, slippageBps: 2 };

test("rejects gaps, duplicates, nonpositive prices and post-listing missing ETH", () => {
  const data = history(); validateP7Datasets(data);
  assert.throws(() => validateP7Datasets({ ...data, "BTC-USD": data["BTC-USD"].slice(1, 2).concat(data["BTC-USD"].slice(3)) }));
  assert.throws(() => validateP7Datasets({ ...data, "BTC-USD": [...data["BTC-USD"], data["BTC-USD"].at(-1)] }));
  assert.throws(() => validateP7Datasets({ ...data, "ETH-USD": [data["BTC-USD"][0]] }));
  const invalid = history(); invalid["BTC-USD"][0].open = 0;
  assert.throws(() => validateP7Datasets(invalid));
});

test("a final signal stays unexecuted without an invented next open", () => {
  const result = replayP7Scenario(history(), scenario);
  assert.equal(result.counters.filled, 0);
  assert.equal(result.counters.unexecutedFinal, 1);
  assert.equal(result.sleeves["BTC-USD"].cash, 10_000);
  assert.equal(result.finalEquity, 20_000);
});

test("the next open cannot change the prior decision quantity", () => {
  const unchanged = replayP7Scenario(history(true, 110), scenario);
  const gap = replayP7Scenario(history(true, 120), scenario);
  assert.equal(unchanged.orders[0].quantity, gap.orders[0].quantity);
  assert.equal(unchanged.orders[0].outcome, "FILLED");
  assert.equal(gap.orders[0].outcome, "INSUFFICIENT_CASH");
  assert.equal(gap.counters.brokerRejected, 1);
  assert.equal(gap.sleeves["BTC-USD"].positionQuantity, 0);
  assert.equal(gap.sleeves["BTC-USD"].cash, 10_000);
});

test("uses the real broker fee and slippage once, with ETH still in cash", () => {
  const result = replayP7Scenario(history(), { id: "C0", execution: "DECISION_CLOSE", feeBps: 60, slippageBps: 2 });
  const order = result.orders[0];
  assert.equal(order.outcome, "FILLED");
  assert.ok(Math.abs(result.fees - order.quantity * 110 * 1.0002 * 0.006) < 1e-9);
  assert.ok(Math.abs(result.slippageCost - order.quantity * 110 * 0.0002) < 1e-9);
  assert.ok(result.sleeves["BTC-USD"].cash >= 0);
  assert.equal(result.sleeves["ETH-USD"].cash, 10_000);
  assert.ok(Math.abs(result.finalEquity - (20_000 - result.fees - result.slippageCost)) < 1e-8);
});

test("a trend exit sells the existing quantity once and accounts for sell fees", () => {
  const data = history(true, 110);
  data["BTC-USD"].at(-1).close = 50;
  data["BTC-USD"].push({ start: start + 241 * DAY, open: 55, close: 54 });
  const result = replayP7Scenario(data, scenario);
  const fills = result.orders.filter((r) => r.outcome === "FILLED");
  assert.equal(fills.length, 2);
  assert.equal(fills[1].side, "SELL");
  assert.equal(fills[0].quantity, fills[1].quantity);
  assert.ok(Math.abs(fills[1].fee - fills[1].quantity * 55 * 0.9998 * 0.006) < 1e-9);
  assert.equal(result.sleeves["BTC-USD"].positionQuantity, 0);
  assert.ok(Math.abs(result.finalEquity - (10_000 + result.sleeves["BTC-USD"].cash)) < 1e-9);
});
