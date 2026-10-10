// Cohérence de la politique P7 runtime avec le rapport
// docs/analysis/allocation-policies-2026-10-09.md (models/target-exposure.md §7).
// Rejoue la décision pure du runtime (fenêtre glissante de 240 bougies), la
// porte de risque §4 (checkRisk + coupe-circuit consolidé) et l'exécution paper
// du runtime, deux créneaux indépendants de 10 000 $.
// Tolérance figée dans le modèle avant la première exécution.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createOrderIntent, createProductId } from "@dodash/domain";
import { planTargetExposure, TARGET_EXPOSURE_MIN_CANDLES, targetExposureRiskGate } from "@dodash/models";
import { executePaperOrder, type PaperPortfolio } from "@dodash/paper-execution";
import { checkRisk } from "@dodash/risk";
import { describe, expect, it } from "vitest";

const EVIDENCE = "../../../docs/analysis/evidence-backtest-daily-long-2026-10-09/";
const FILES = {
  "BTC-USD": { file: "job--BTC-USD.json", sha256: "233ded0cc0d1db2ceebc9ceb635ad92e54c016ad43fc231a0a72a797af99890b" },
  "ETH-USD": { file: "job--ETH-USD.json", sha256: "560e32c3307bfd8efe23e65676cb84582dea80221f03b232fe11e2566698f43a" },
} as const;
const BROKER = { feeBps: 60, slippageBps: 2 };
const SLEEVE_CAPITAL = 10_000;
const REPORT = { cagr: 0.52, maxDrawdown: 0.456 };
const WINDOWS = [
  ["2015-07-21", "2018-01-01"],
  ["2018-01-01", "2020-01-01"],
  ["2020-01-01", "2022-01-01"],
  ["2022-01-01", "2024-01-01"],
  ["2024-01-01", "2026-10-01"],
] as const;

type Candle = { readonly start: number; readonly close: number };

const loadCandles = (product: keyof typeof FILES): Candle[] => {
  const raw = readFileSync(fileURLToPath(new URL(EVIDENCE + FILES[product].file, import.meta.url)));
  expect(createHash("sha256").update(raw).digest("hex")).toBe(FILES[product].sha256);
  const job = JSON.parse(raw.toString("utf8")) as { candles: [number, number, number][] };
  return job.candles.map(([start, , close]) => ({ start, close }));
};

// Configuration de risque paper P7 (models/target-exposure.md §6).
const RISK = {
  maxOrderNotional: 1e12,
  maxPositionNotional: 1e12,
  maxGrossExposure: 1e12,
  maxDailyLoss: 2_500,
  cooldownMs: 0,
  stopLossBps: 150,
  takeProfitBps: 300,
};
const PORTFOLIO_MAX_DAILY_LOSS = 5_000;
const PRODUCTS = ["BTC-USD", "ETH-USD"] as const;

/** Rejoue les deux créneaux jour par jour : décision, porte de risque §4, exécution paper. */
const replay = (calendar: readonly number[]) => {
  const candles = Object.fromEntries(PRODUCTS.map((product) => [product, loadCandles(product)])) as Record<
    (typeof PRODUCTS)[number],
    Candle[]
  >;
  const index: Record<string, number> = { "BTC-USD": 0, "ETH-USD": 0 };
  const sleeves: Record<string, PaperPortfolio> = Object.fromEntries(
    PRODUCTS.map((product) => [product, { cash: SLEEVE_CAPITAL, positionQuantity: 0, averagePrice: 0 }]),
  );
  const previousEquity: Record<string, number> = { "BTC-USD": SLEEVE_CAPITAL, "ETH-USD": SLEEVE_CAPITAL };
  const totals: number[] = [];
  const counters = { orders: 0, blockedBuys: 0, rejectedSells: 0 };
  for (const day of calendar) {
    const marks: Record<string, number> = {};
    for (const product of PRODUCTS) {
      const candle = candles[product][index[product] ?? 0];
      const sleeve = sleeves[product] as PaperPortfolio;
      marks[product] = candle?.start === day ? sleeve.cash + sleeve.positionQuantity * candle.close : sleeve.cash;
    }
    const portfolioDailyPnl = PRODUCTS.reduce((sum, product) => sum + (marks[product] ?? 0) - (previousEquity[product] ?? 0), 0);
    for (const product of PRODUCTS) {
      const position = index[product] ?? 0;
      const candle = candles[product][position];
      if (candle === undefined || candle.start !== day) continue; // créneau ETH en cash avant sa cotation
      const productId = createProductId(product);
      if (!productId.ok) throw new Error("produit invalide");
      const sleeve = sleeves[product] as PaperPortfolio;
      const decision = planTargetExposure({
        candles: candles[product].slice(Math.max(0, position - TARGET_EXPOSURE_MIN_CANDLES + 1), position + 1),
        positionQuantity: sleeve.positionQuantity,
        cash: sleeve.cash,
        ...BROKER,
      });
      if (decision.side !== "HOLD") {
        const intent = createOrderIntent({
          clientOrderId: `coherence-${product}-${day}`,
          decisionId: `coherence-${product}-${day}`,
          strategyIds: ["target-exposure"],
          productId: productId.value,
          side: decision.side,
          type: "MARKET",
          quantity: decision.quantity,
          limitPrice: null,
        });
        if (!intent.ok) throw new Error("intention invalide");
        const gate = targetExposureRiskGate(decision.side, (marks[product] ?? 0) - (previousEquity[product] ?? 0));
        const risk = checkRisk(
          intent.value,
          {
            marketPrice: candle.close,
            currentPositionQuantity: sleeve.positionQuantity,
            otherExposureNotional: 0,
            dailyPnl: gate.dailyPnlForRisk,
            lastTradeAt: null,
            now: day,
            killSwitchActive: false,
          },
          RISK,
        );
        if (!risk.ok) throw new Error(`risque invalide ${risk.error.code}`);
        const admitted = !gate.portfolioAdmission || portfolioDailyPnl > -PORTFOLIO_MAX_DAILY_LOSS;
        if (risk.value.status === "APPROVED" && admitted) {
          const execution = executePaperOrder(sleeve, intent.value, candle.close, day, BROKER);
          if (!execution.ok) throw new Error(`exécution refusée ${execution.error.code}`);
          sleeves[product] = execution.value.portfolio;
          counters.orders += 1;
        } else if (decision.side === "BUY") {
          counters.blockedBuys += 1;
        } else {
          counters.rejectedSells += 1;
        }
      }
      const after = sleeves[product] as PaperPortfolio;
      expect(after.cash).toBeGreaterThanOrEqual(-1e-6); // INV-T2
      expect(after.positionQuantity).toBeGreaterThanOrEqual(-1e-9); // INV-T3
      index[product] = position + 1;
    }
    let total = 0;
    for (const product of PRODUCTS) {
      const candle = candles[product][(index[product] ?? 0) - 1];
      const sleeve = sleeves[product] as PaperPortfolio;
      const equity = candle !== undefined && candle.start === day ? sleeve.cash + sleeve.positionQuantity * candle.close : sleeve.cash;
      previousEquity[product] = equity;
      total += equity;
    }
    totals.push(total);
  }
  return { totals, counters };
};

const maxDrawdown = (values: readonly number[]): number => {
  let peak = values[0] ?? 0;
  let drawdown = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    drawdown = Math.max(drawdown, 1 - value / peak);
  }
  return drawdown;
};

describe("cohérence P7 runtime ↔ rapport (models/target-exposure.md §7)", () => {
  it("reproduit le rapport à la tolérance figée", () => {
    const calendar = loadCandles("BTC-USD").map((candle) => candle.start);
    const { totals: total, counters } = replay(calendar);
    const years = (total.length - 1) / 365.25;
    const cagr = ((total.at(-1) ?? 0) / (2 * SLEEVE_CAPITAL)) ** (1 / years) - 1;
    const drawdown = maxDrawdown([2 * SLEEVE_CAPITAL, ...total]);
    const windows = WINDOWS.map(([from, to]) => {
      const start = Date.parse(`${from}T00:00:00Z`);
      const end = Date.parse(`${to}T00:00:00Z`);
      const first = calendar.findIndex((day) => day >= start);
      const opening = first > 0 ? (total[first - 1] ?? 0) : 2 * SLEEVE_CAPITAL;
      return maxDrawdown([opening, ...total.filter((_, i) => (calendar[i] ?? 0) >= start && (calendar[i] ?? 0) < end)]);
    });
    console.info(JSON.stringify({ cagr, maxDrawdown: drawdown, windows, final: total.at(-1), counters }));
    expect(counters.rejectedSells).toBe(0); // INV-T7
    expect(drawdown).toBeLessThanOrEqual(0.5);
    for (const value of windows) expect(value).toBeLessThanOrEqual(0.5);
    expect(Math.abs(cagr - REPORT.cagr)).toBeLessThanOrEqual(0.08);
    expect(Math.abs(drawdown - REPORT.maxDrawdown)).toBeLessThanOrEqual(0.06);
  });
});
