import { createRequire } from "node:module";

const require = createRequire(new URL("../../packages/backtest/package.json", import.meta.url));
const { createOrderIntent, createProductId } = await import(require.resolve("@dodash/domain"));
const { planTargetExposure, targetExposureRiskGate, decisionCandlePnl, TARGET_EXPOSURE_MIN_CANDLES } = await import(require.resolve("@dodash/models"));
const { checkRisk } = await import(require.resolve("@dodash/risk"));
const { executePaperOrder } = await import(require.resolve("@dodash/paper-execution"));

export const DAY = 86_400_000;
export const PRODUCTS = ["BTC-USD", "ETH-USD"];
export const WINDOWS = [
  ["W1", "2015-07-21", "2018-01-01"], ["W2", "2018-01-01", "2020-01-01"],
  ["W3", "2020-01-01", "2022-01-01"], ["W4", "2022-01-01", "2024-01-01"],
  ["W5", "2024-01-01", "2026-10-01"],
];
const RISK = { maxOrderNotional: 1e12, maxPositionNotional: 1e12, maxGrossExposure: 1e12,
  maxDailyLoss: 2_500, cooldownMs: 0, stopLossBps: 150, takeProfitBps: 300 };

export const decodeP7Archive = (job, product) => {
  if (!PRODUCTS.includes(product) || job.product !== product || job.timeframe !== "ONE_DAY" || job.status !== "OK" ||
    !Array.isArray(job.candles) || job.dataset?.filled !== (product === "BTC-USD" ? 0 : 2) ||
    job.dataset.candles !== job.candles.length || job.dataset.filled > job.candles.length) throw new Error("INVALID_DATASET_IDENTITY");
  return job.candles.map((tuple) => {
    if (!Array.isArray(tuple) || tuple.length !== 3) throw new Error("INVALID_CANDLE_TUPLE");
    return { start: tuple[0], open: tuple[1], close: tuple[2] };
  });
};

export const validateP7Datasets = (datasets) => {
  if (!Array.isArray(datasets["BTC-USD"]) || datasets["BTC-USD"].length < 2 || !Array.isArray(datasets["ETH-USD"])) throw new Error("INVALID_DATASET");
  for (const product of PRODUCTS) {
    const rows = datasets[product];
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i];
      if (!Number.isSafeInteger(c.start) || c.start < 0 || c.start % DAY !== 0 ||
        !Number.isFinite(c.open) || c.open <= 0 || !Number.isFinite(c.close) || c.close <= 0 ||
        (i > 0 && c.start !== rows[i - 1].start + DAY)) throw new Error("INVALID_CANDLE_GRID");
    }
  }
  const btc = datasets["BTC-USD"], eth = datasets["ETH-USD"];
  if (eth.length > 0) {
    const listing = btc.findIndex((c) => c.start === eth[0].start);
    if (listing < 0 || eth.length !== btc.length - listing || eth.some((c, i) => c.start !== btc[listing + i].start)) throw new Error("INVALID_ETH_ALIGNMENT");
  }
};

export const maximumDrawdown = (values) => {
  let peak = values[0], drawdown = 0;
  if (values.length === 0 || values.some((v) => !Number.isFinite(v) || v <= 0)) throw new Error("INVALID_EQUITY");
  for (const value of values) { peak = Math.max(peak, value); drawdown = Math.max(drawdown, 1 - value / peak); }
  return drawdown;
};

export const replayP7Scenario = (datasets, scenario) => {
  validateP7Datasets(datasets);
  if (!["DECISION_CLOSE", "NEXT_OPEN"].includes(scenario.execution) ||
    ![scenario.feeBps, scenario.slippageBps].every((n) => Number.isFinite(n) && n >= 0 && n < 10_000)) throw new Error("INVALID_SCENARIO");
  const sleeves = Object.fromEntries(PRODUCTS.map((p) => [p, { cash: 10_000, positionQuantity: 0, averagePrice: 0 }]));
  const positions = { "BTC-USD": 0, "ETH-USD": 0 }, pending = {};
  const equity = [], orders = [];
  const counters = { filled: 0, blockedBuys: 0, rejectedSells: 0, brokerRejected: 0, unexecutedFinal: 0 };
  let fees = 0, slippageCost = 0, minCash = 10_000, minQuantity = 0;
  const execute = (product, intent, decisionStart, candle, price) => {
    const result = executePaperOrder(sleeves[product], intent, price, candle.start + (scenario.execution === "DECISION_CLOSE" ? DAY : 0), scenario);
    const row = { product, decisionStart, executionStart: candle.start, side: intent.side, quantity: intent.quantity, marketPrice: price };
    if (!result.ok) {
      if (!["INSUFFICIENT_CASH", "INSUFFICIENT_POSITION"].includes(result.error.code)) throw new Error(result.error.code);
      counters.brokerRejected++; orders.push({ ...row, outcome: result.error.code }); return;
    }
    sleeves[product] = result.value.portfolio;
    fees += result.value.trade.fill.fee;
    slippageCost += Math.abs(result.value.trade.fill.price - price) * intent.quantity;
    counters.filled++;
    orders.push({ ...row, outcome: "FILLED", price: result.value.trade.fill.price, fee: result.value.trade.fill.fee });
  };
  for (const btcDay of datasets["BTC-USD"]) {
    for (const product of PRODUCTS) {
      const index = positions[product], candle = datasets[product][index];
      if (candle === undefined || candle.start !== btcDay.start) continue;
      if (pending[product] !== undefined) {
        const order = pending[product];
        execute(product, order.intent, order.decisionStart, candle, candle.open);
        delete pending[product];
      }
      const sleeve = sleeves[product];
      const window = datasets[product].slice(Math.max(0, index - TARGET_EXPOSURE_MIN_CANDLES + 1), index + 1);
      const decision = planTargetExposure({ candles: window, cash: sleeve.cash, positionQuantity: sleeve.positionQuantity, ...scenario });
      if (decision.side !== "HOLD") {
        const productId = createProductId(product); if (!productId.ok) throw new Error("INVALID_PRODUCT");
        const identity = `robustness-${scenario.id}-${product}-${candle.start}`;
        const intent = createOrderIntent({ clientOrderId: identity, decisionId: identity, strategyIds: ["target-exposure"],
          productId: productId.value, side: decision.side, type: "MARKET", quantity: decision.quantity, limitPrice: null });
        if (!intent.ok) throw new Error("INVALID_INTENT");
        const gate = targetExposureRiskGate(decision.side, 0, decisionCandlePnl(window, sleeve.positionQuantity));
        const risk = checkRisk(intent.value, { marketPrice: candle.close, currentPositionQuantity: sleeve.positionQuantity,
          otherExposureNotional: 0, dailyPnl: gate.dailyPnlForRisk, lastTradeAt: null, now: candle.start, killSwitchActive: false }, RISK);
        if (!risk.ok) throw new Error("INVALID_RISK");
        if (risk.value.status !== "APPROVED") {
          if (decision.side === "BUY") counters.blockedBuys++; else counters.rejectedSells++;
          orders.push({ product, decisionStart: candle.start, side: decision.side, quantity: decision.quantity, outcome: "RISK_REJECTED", reason: risk.value.reasonCode });
        } else if (scenario.execution === "DECISION_CLOSE") execute(product, intent.value, candle.start, candle, candle.close);
        else pending[product] = { intent: intent.value, decisionStart: candle.start };
      }
      const after = sleeves[product];
      if (!Number.isFinite(after.cash) || after.cash < 0 || !Number.isFinite(after.positionQuantity) || after.positionQuantity < 0) throw new Error("PORTFOLIO_INVARIANT_FAILED");
      minCash = Math.min(minCash, after.cash); minQuantity = Math.min(minQuantity, after.positionQuantity);
      positions[product]++;
    }
    const total = PRODUCTS.reduce((sum, product) => {
      const candle = datasets[product][positions[product] - 1], sleeve = sleeves[product];
      return sum + sleeve.cash + (candle !== undefined ? sleeve.positionQuantity * candle.close : 0);
    }, 0);
    if (!Number.isFinite(total) || total <= 0) throw new Error("INVALID_EQUITY");
    equity.push({ start: btcDay.start, equity: total });
  }
  for (const product of PRODUCTS) if (pending[product] !== undefined) {
    const order = pending[product]; counters.unexecutedFinal++;
    orders.push({ product, decisionStart: order.decisionStart, side: order.intent.side, quantity: order.intent.quantity, outcome: "UNEXECUTED_FINAL" });
  }
  const finalEquity = equity.at(-1).equity;
  return { ...scenario, finalEquity, netReturn: finalEquity / 20_000 - 1,
    cagr: (finalEquity / 20_000) ** (365.25 / (equity.length - 1)) - 1,
    maxDrawdown: maximumDrawdown([20_000, ...equity.map((e) => e.equity)]),
    counters, fees, slippageCost, minCash, minQuantity, sleeves, equity, orders };
};

export const summarizeP7Windows = (result) => WINDOWS.map(([id, from, to]) => {
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`);
  const first = result.equity.findIndex((e) => e.start >= start);
  const opening = first > 0 ? result.equity[first - 1].equity : 20_000;
  const rows = result.equity.filter((e) => e.start >= start && e.start < end);
  if (rows.length === 0) throw new Error("INCOMPLETE_WINDOW");
  const values = [opening, ...rows.map((e) => e.equity)];
  return { id, from, to, cagr: (values.at(-1) / opening) ** (365.25 / rows.length) - 1, maxDrawdown: maximumDrawdown(values) };
});
