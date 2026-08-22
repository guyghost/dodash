// Campagne D2 — protocole models/risk-rejection-diagnosis.md §5.
// 10 fenêtres annuelles (2016→2026) × 4 profils sous config V1 bit-identique
// au walk-forward sizing. Sortie : riskRejectionRate + décomposition par
// reasonCode (Q1), sanité INV-D2 par run, contrôle WF2/INV-D1 bit-identique,
// attribution H1-H3 vs critère D3 ≥ 95 % (Q3).

import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import { createProductId } from "@dodash/domain";
import {
  RISK_REJECTION_REASON_CODES,
  type ConfidenceCalibrationProfile,
  type RiskRejectionReasonCode,
} from "@dodash/models";

import { loadCoinbaseHistoricalDataset } from "../src/coinbase-history.js";
import type { BacktestSuiteConfig } from "../src/suite.js";
import { runBacktestSuite } from "../src/suite.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

const PROFILES: readonly ConfidenceCalibrationProfile[] = [
  "IDENTITY",
  "POWER_HALF",
  "POWER_THIRD",
  "POWER_QUARTER",
];
const START_YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] as const;

// Hypothèses §2 : H1 kill switch cumulatif, H2 short à plat, H3 plafond position.
const H1: RiskRejectionReasonCode = "DAILY_LOSS_LIMIT";
const H2: RiskRejectionReasonCode = "SPOT_SHORT_FORBIDDEN";
const H3: RiskRejectionReasonCode = "POSITION_NOTIONAL_LIMIT";

const DAY = 86_400_000;
const windowBounds = (year: number): { startAt: number; endAt: number } => {
  const startAt = Date.parse(`${year}-08-21T00:00:00Z`);
  const endAt = Date.parse(`${year + 1}-08-21T00:00:00Z`);
  if (Number.isNaN(startAt) || Number.isNaN(endAt) || startAt % DAY !== 0 || endAt % DAY !== 0) {
    throw new Error(`unaligned window ${year}`);
  }
  return { startAt, endAt };
};

const makeConfig = (
  year: number,
  profile: ConfidenceCalibrationProfile,
): BacktestSuiteConfig =>
  ({
    runId: `risk-attribution-${year}-${profile}`,
    agentId: "dodash-backtest",
    initialCapital: 10_000,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    targetSignalNotional: 1_000,
    confidenceCalibration: profile,
    indicators: DEFAULT_INDICATOR_CONFIG,
    risk: {
      maxOrderNotional: 2_000,
      maxPositionNotional: 10_000,
      maxGrossExposure: 20_000,
      maxDailyLoss: 1_000,
      cooldownMs: 0,
      stopLossBps: 150,
      takeProfitBps: 300,
    },
    broker: { feeBps: 6, slippageBps: 2 },
    protectiveExit: {
      mode: "REGIME_CONDITIONAL",
      bullish: { mode: "NONE" },
      bearish: { mode: "FIXED_BPS", stopLossBps: 300, takeProfitBps: 600 },
      range: { mode: "FIXED_BPS", stopLossBps: 300, takeProfitBps: 600 },
      warmUp: { mode: "FIXED_BPS", stopLossBps: 300, takeProfitBps: 600 },
    },
    regimeFilter: {
      mode: "EMA_THRESHOLD",
      thresholdBps: 100,
      minObservations: 5,
      confirmationCount: 3,
    },
  }) as BacktestSuiteConfig;

interface RunMeasurement {
  readonly totalReturn: number;
  readonly maxDrawdown: number;
  readonly riskRejectionRate: number;
  readonly riskRejectedCount: number;
  readonly riskRejectionReasons: Readonly<Record<RiskRejectionReasonCode, number>>;
  readonly totalReasons: number;
}

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;

const totals = new Map<RiskRejectionReasonCode, number>(
  RISK_REJECTION_REASON_CODES.map((code) => [code, 0]),
);
const totalsByProfile = new Map<ConfidenceCalibrationProfile, Map<RiskRejectionReasonCode, number>>(
  PROFILES.map((profile) => [profile, new Map(RISK_REJECTION_REASON_CODES.map((code) => [code, 0]))]),
);
const rateByProfile = new Map<ConfidenceCalibrationProfile, number[]>(
  PROFILES.map((profile) => [profile, []]),
);
let invD2Violations = 0;

for (const year of START_YEARS) {
  const { startAt, endAt } = windowBounds(year);
  const dataset = await loadCoinbaseHistoricalDataset({
    productId: product.value,
    timeframe: "ONE_DAY",
    startAt,
    endAt,
  });
  if (!dataset.ok) {
    console.log(`${year}: DONNÉES INDISPONIBLES (${dataset.error.code}) — fenêtre éliminée`);
    continue;
  }
  console.log(`${year}: ${dataset.value.candles.length} candles chargées`);
  for (const profile of PROFILES) {
    const result = await runBacktestSuite(dataset.value, makeConfig(year, profile));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const ensemble = result.value.scenarios.find((s) => s.id === "ensemble");
    if (!ensemble) throw new Error(`missing ensemble scenario ${year}/${profile}`);
    const allocation = ensemble.diagnostics.allocation;
    const m: RunMeasurement = {
      totalReturn: ensemble.metrics.totalReturn,
      maxDrawdown: ensemble.metrics.maxDrawdown,
      riskRejectionRate: allocation.riskRejectionRate,
      riskRejectedCount: allocation.riskRejectedCount,
      riskRejectionReasons: allocation.riskRejectionReasons,
      totalReasons: RISK_REJECTION_REASON_CODES.reduce(
        (sum, code) => sum + allocation.riskRejectionReasons[code],
        0,
      ),
    };
    // INV-D2 (sanité agrégée) : décisions rejetées ⟺ motifs présents, et
    // chaque décision rejetée contribue ≥ 1 motif.
    const invD2Ok =
      (m.riskRejectedCount === 0) === (m.totalReasons === 0) &&
      m.totalReasons >= m.riskRejectedCount;
    if (!invD2Ok) invD2Violations += 1;
    for (const code of RISK_REJECTION_REASON_CODES) {
      const count = m.riskRejectionReasons[code];
      totals.set(code, (totals.get(code) ?? 0) + count);
      const profileTotals = totalsByProfile.get(profile)!;
      profileTotals.set(code, (profileTotals.get(code) ?? 0) + count);
    }
    rateByProfile.get(profile)!.push(m.riskRejectionRate);
    const decomposition = RISK_REJECTION_REASON_CODES.filter((code) => m.riskRejectionReasons[code] > 0)
      .map((code) => `${code}:${m.riskRejectionReasons[code]}`)
      .join(" ");
    console.log(
      `  ${profile.padEnd(14)} ret ${pct(m.totalReturn).padStart(7)} dd ${pct(m.maxDrawdown).padStart(6)} | riskRej ${pct(m.riskRejectionRate)} (${m.riskRejectedCount} décisions, ${m.totalReasons} ordres) ${invD2Ok ? "" : "⚠️ INV-D2"}| ${decomposition || "aucun rejet"}`,
    );
  }
}

// WF2 / INV-D1 — contrôle bit-identique sur les fenêtres de référence.
console.log("\n== WF2 contrôle de non-dérive (IDENTITY vs baseline V1) ==");
const wf2Expectations: ReadonlyArray<{ year: number; ret: number; dd: number }> = [
  { year: 2023, ret: 0.0027, dd: 0.0293 },
  { year: 2025, ret: 0.0363, dd: 0.0337 },
];
let wf2Ok = true;
const baselineCache = new Map<number, RunMeasurement>();
for (const expected of wf2Expectations) {
  const { startAt, endAt } = windowBounds(expected.year);
  const dataset = await loadCoinbaseHistoricalDataset({
    productId: product.value,
    timeframe: "ONE_DAY",
    startAt,
    endAt,
  });
  if (!dataset.ok) throw new Error(`baseline data unavailable ${expected.year}`);
  const result = await runBacktestSuite(dataset.value, makeConfig(expected.year, "IDENTITY"));
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const ensemble = result.value.scenarios.find((s) => s.id === "ensemble")!;
  const m: RunMeasurement = {
    totalReturn: ensemble.metrics.totalReturn,
    maxDrawdown: ensemble.metrics.maxDrawdown,
    riskRejectionRate: ensemble.diagnostics.allocation.riskRejectionRate,
    riskRejectedCount: ensemble.diagnostics.allocation.riskRejectedCount,
    riskRejectionReasons: ensemble.diagnostics.allocation.riskRejectionReasons,
    totalReasons: RISK_REJECTION_REASON_CODES.reduce(
      (sum, code) => sum + ensemble.diagnostics.allocation.riskRejectionReasons[code],
      0,
    ),
  };
  baselineCache.set(expected.year, m);
  const matches =
    Math.abs(m.totalReturn - expected.ret) < 0.000_05 &&
    Math.abs(m.maxDrawdown - expected.dd) < 0.000_05;
  wf2Ok = wf2Ok && matches;
  console.log(
    `${expected.year}: ret ${pct(m.totalReturn)} (att. ${pct(expected.ret)}) dd ${pct(m.maxDrawdown)} (att. ${pct(expected.dd)}) ${matches ? "OK" : "ÉCART"}`,
  );
}
console.log(`WF2 : ${wf2Ok ? "PASS" : "FAIL"}`);

// Q1 — attribution globale et par profil.
const grandTotal = RISK_REJECTION_REASON_CODES.reduce((sum, code) => sum + (totals.get(code) ?? 0), 0);
console.log("\n== Q1 Attribution globale par reasonCode ==");
for (const code of RISK_REJECTION_REASON_CODES) {
  const count = totals.get(code) ?? 0;
  const share = grandTotal === 0 ? 0 : count / grandTotal;
  console.log(`  ${code.padEnd(24)} ${String(count).padStart(6)}  ${pct(share).padStart(7)}`);
}
console.log(`  TOTAL ${String(grandTotal).padStart(28)} ordres rejetés`);

console.log("\n== Attribution par profil ==");
for (const profile of PROFILES) {
  const profileTotals = totalsByProfile.get(profile)!;
  const profileGrand = RISK_REJECTION_REASON_CODES.reduce(
    (sum, code) => sum + (profileTotals.get(code) ?? 0),
    0,
  );
  const rates = rateByProfile.get(profile)!;
  const medianRate = rates.length === 0 ? 0 : [...rates].sort((a, b) => a - b)[Math.floor(rates.length / 2)]!;
  const decomposition = RISK_REJECTION_REASON_CODES.filter((code) => (profileTotals.get(code) ?? 0) > 0)
    .map((code) => `${code}:${profileTotals.get(code)}`)
    .join(" ");
  console.log(
    `  ${profile.padEnd(14)} ${String(profileGrand).padStart(5)} ordres | riskRej médian ${pct(medianRate)} | ${decomposition || "aucun rejet"}`,
  );
}

// D3 — critères §4 : couverture H1-H3 ≥ 95 %, INV-D2 sans violation.
console.log("\n== Critères D3 ==");
const h123 =
  (totals.get(H1) ?? 0) + (totals.get(H2) ?? 0) + (totals.get(H3) ?? 0);
const coverage = grandTotal === 0 ? 1 : h123 / grandTotal;
console.log(`H1+H2+H3 = ${h123}/${grandTotal} ordres (${pct(coverage)}) — seuil ≥ 95 % → ${coverage >= 0.95 ? "PASS" : "FAIL"}`);
console.log(`INV-D2 violations : ${invD2Violations} → ${invD2Violations === 0 ? "PASS" : "FAIL"}`);
const verdictD3 = coverage >= 0.95 && invD2Violations === 0 && wf2Ok;
console.log(
  `\nVERDICT D3 : ${verdictD3 ? "MESURÉ — attribution valide" : "INVALIDE (à reprendre)"}${wf2Ok ? "" : " (WF2 FAIL)"}`,
);
