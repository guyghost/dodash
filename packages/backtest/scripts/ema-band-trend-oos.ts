// Campagne H-T1 — models/ema-band-trend.md (pré-enregistré a priori,
// review approuvée 2026-08-28 : models/ema-band-trend.review.md).
// Phase 1 découverte exécutée le 2026-08-28 (listing SPOT 929 produits,
// 377 candidats USD/online hors exclusions — 24 consultés + 2 stables +
// 0 empaquetés ; sondes 5/5 × 10 fenêtres ; 39 éligibles ≥ 5 fenêtres).
// SÉLECTION GELÉE (INV-T8) par la fonction pure §6.2 (fenêtres présentes
// desc, volume_24h desc, product_id asc), consignée AVANT toute lecture
// économique — la première exécution a planté sur un bug de script avant
// toute sortie de métrique ; le gel prime, la re-découverte est écartée
// (relevé complet dans models/ema-band-trend.md §12).
// Phase 2 campagne : par produit, chargement complet + UN replay SOLO
// ema-band-trend (exits NONE, permission 3 régimes, reste du plumbing
// bit-identique H-D1). Contrôle INV-T7 BTC (V1 bit-exact, jamais mesuré
// pour le candidat). EFF1/EFF2 : morsure mesurée en fills.
// Phase 3 portes G1-G6 par produit + verdict global (§7) + lectures
// consignées hors critères (buy & hold, sans-risque 4 %, exposition…).
// Exécution : node --experimental-strip-types scripts/ema-band-trend-oos.ts
// (depuis packages/backtest, après pnpm build).

import {
  loadCoinbaseHistoricalDataset,
  prepareBacktestIndicators,
  replayBacktest,
  withConfidenceCalibration,
  withTargetSignalNotional,
  type BacktestConfig,
} from "@dodash/backtest";
import {
  TIMEFRAME_MILLISECONDS,
  createProductId,
  type Candle,
  type Strategy,
} from "@dodash/domain";
import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import {
  createBreakoutStrategy,
  createEmaBandTrendStrategy,
  createEmaCrossStrategy,
  createRsiReversionStrategy,
  createStrategyRegistry,
} from "@dodash/strategies";

// §6.1 — exclusions appliquées à la découverte du 2026-08-28 : 20
// consultés historiques + ZRX, OXT, KNC, DASH brûlés par H-D1 = 24,
// + stablecoins + empaquetés (append-only).

const START_YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] as const;
const DAY = 86_400_000;
// Lecture consignée hors critères (§7) : proxy de taux sans risque,
// hypothèse externe — information K1, pas une porte.
const RISK_FREE_ANNUAL = 0.04;

// SÉLECTION GELÉE (INV-T8) — cf. en-tête.
const SELECTED = [
  { productId: "BAND-USD", present: 6, volume24h: 33633.95 },
  { productId: "COMP-USD", present: 6, volume24h: 19878.052 },
  { productId: "NMR-USD", present: 6, volume24h: 18381.132 },
  { productId: "AMP-USD", present: 5, volume24h: 1_332_808_794 },
] as const;

console.log("== Phase 1 : découverte (exécutée 2026-08-28, gel consigné) ==");
console.log(
  "39 éligibles ≥ 5/10 fenêtres ; fonction pure (fenêtres desc, volume desc, id asc) :",
);
for (const c of SELECTED)
  console.log(`  ${c.productId} (fenêtres présentes ${c.present}/10, vol24h ${c.volume24h})`);

const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 === 1
    ? s[(s.length - 1) / 2]!
    : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

const windowStart = (year: number): number => {
  const t = Date.parse(`${year}-08-21T00:00:00Z`);
  if (Number.isNaN(t) || t % DAY !== 0) throw new Error(`unaligned ${year}`);
  return t;
};

// ---------- Phase 2 : campagne ----------

// INV-T7 — le contrôle BTC rejoue l'ensemble V1 (config H-D1 bit-identique) ;
// le module candidat est présent mais hors registry mesuré.
const ensembleStrategies = (targetNotional: number): readonly Strategy[] => {
  const size = (s: Strategy): Strategy => withTargetSignalNotional(s, targetNotional);
  const calibrate = (s: Strategy): Strategy => withConfidenceCalibration(s, "IDENTITY");
  return [
    size(createRsiReversionStrategy({ oversold: 30, overbought: 70, baseSize: targetNotional })),
    size(calibrate(createEmaCrossStrategy({ baseSize: targetNotional }))),
    size(calibrate(createBreakoutStrategy({ lookback: 20, baseSize: targetNotional }))),
  ];
};

// §6.3 — candidat solo : exits NONE, permission trois régimes.
const candidateStrategies = (targetNotional: number): readonly Strategy[] => [
  withTargetSignalNotional(
    createEmaBandTrendStrategy({ baseSize: targetNotional }),
    targetNotional,
  ),
];

const riskConfig = {
  maxOrderNotional: 2_000,
  maxPositionNotional: 10_000,
  maxGrossExposure: 20_000,
  maxDailyLoss: 1_000,
  cooldownMs: 0,
  stopLossBps: 150,
  takeProfitBps: 300,
} as const;

const REGIME_FILTER = {
  mode: "EMA_THRESHOLD",
  thresholdBps: 100,
  minObservations: 5,
  confirmationCount: 3,
} as const;

interface FoldResult {
  readonly year: number;
  readonly totalReturn: number;
  readonly maxDrawdown: number;
  readonly closedTrades: number;
  readonly buyFills: number;
  readonly sellFills: number;
  readonly netPnl: number;
  readonly grossWin: number;
  readonly grossLoss: number;
  readonly fees: number;
  readonly turnover: number;
  readonly exposure: number;
  readonly avgHoldingDays: number | null;
  readonly buyHold: number;
}

type WindowOutcome =
  | { ok: false; code: string }
  | { ok: true; fold: FoldResult };

const replayCandidateWindow = async (
  productId: string,
  year: number,
): Promise<WindowOutcome> => {
  const product = createProductId(productId);
  if (!product.ok) return { ok: false, code: "INVALID_PRODUCT_ID" };
  const startAt = windowStart(year);
  const endAt = windowStart(year + 1);
  const dataset = await loadCoinbaseHistoricalDataset({
    productId: product.value,
    timeframe: "ONE_DAY",
    startAt,
    endAt,
  });
  if (!dataset.ok) return { ok: false, code: dataset.error.code };
  const candles = dataset.value.candles;
  const registry = createStrategyRegistry(candidateStrategies(1_000));
  if (!registry.ok) throw new Error(JSON.stringify(registry.error));
  const prepared = await prepareBacktestIndicators(candles, DEFAULT_INDICATOR_CONFIG);
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const config: BacktestConfig = {
    intervalMs: TIMEFRAME_MILLISECONDS["ONE_DAY"],
    runId: `ht1-${productId.replace("-", "").toLowerCase()}-${year}`,
    agentId: "dodash-backtest",
    productId: product.value,
    initialCapital: 10_000,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    indicators: DEFAULT_INDICATOR_CONFIG,
    strategies: registry.value,
    risk: { ...riskConfig },
    broker: { feeBps: 6, slippageBps: 2 },
    protectiveExit: { mode: "NONE" },
    regimeFilter: { ...REGIME_FILTER },
    regimePermissions: {
      BULLISH: ["ema-band-trend"],
      BEARISH: ["ema-band-trend"],
      RANGE: ["ema-band-trend"],
    },
  };
  const replay = await replayBacktest(candles, config, prepared.value);
  if (!replay.ok) return { ok: false, code: replay.error.code };
  const closed = replay.value.trades.filter((t) => t.closedQuantity > 0);
  const grossWin = closed.reduce((s, t) => s + Math.max(t.realizedPnl, 0), 0);
  const grossLoss = closed.reduce((s, t) => s + Math.max(-t.realizedPnl, 0), 0);
  // EFF2 — morsure exécutable : BUY = fill qui n'a jamais clôturé (une
  // position achetée ne clôt rien) ; SELL = fill clôturant. Spot long-only.
  const buyFills = replay.value.trades.filter((t) => t.closedQuantity === 0).length;
  const sellFills = closed.length;
  // Exposition : suivi local de la position (PaperTrade ne porte pas le
  // portefeuille) — BUY ⇒ += fill.quantity (closedQuantity 0), SELL ⇒
  // −= closedQuantity ; résidus flottants rattrapés par une tolérance
  // miroir de paper-execution. Position ouverte en fin de fenêtre
  // prolongée jusqu'à la fin du dernier candle.
  let holdingMs = 0;
  let intervals = 0;
  let openSince: number | null = null;
  let position = 0;
  const tolerance = 1e-12;
  for (const trade of replay.value.trades) {
    position =
      trade.closedQuantity === 0
        ? position + trade.fill.quantity
        : position - trade.closedQuantity;
    if (Math.abs(position) <= tolerance) position = 0;
    if (position > 0 && openSince === null) openSince = trade.fill.executedAt;
    if (position === 0 && openSince !== null) {
      holdingMs += trade.fill.executedAt - openSince;
      intervals += 1;
      openSince = null;
    }
  }
  const windowEnd = (candles.at(-1)?.start ?? startAt) + DAY;
  if (openSince !== null) {
    holdingMs += windowEnd - openSince;
    intervals += 1;
  }
  const exposure = holdingMs / (endAt - startAt);
  const avgHoldingDays = intervals > 0 ? holdingMs / intervals / DAY : null;
  // Buy & hold consigné (sans frais) : dernier close / premier close − 1.
  const first = candles[0];
  const last = candles.at(-1);
  const buyHold =
    first !== undefined && last !== undefined && first.close > 0
      ? last.close / first.close - 1
      : Number.NaN;
  return {
    ok: true,
    fold: {
      year,
      totalReturn: replay.value.metrics.totalReturn,
      maxDrawdown: replay.value.metrics.maxDrawdown,
      closedTrades: closed.length,
      buyFills,
      sellFills,
      netPnl: replay.value.metrics.pnl,
      grossWin,
      grossLoss,
      fees: replay.value.metrics.fees,
      turnover: replay.value.metrics.turnover,
      exposure,
      avgHoldingDays,
      buyHold,
    },
  };
};

// INV-T7 — contrôle de câblage BTC : l'ensemble V1 par le même code-path,
// baselines H-D1 (2023 +0,27 %/2,93 % ; 2025 +3,63 %/3,37 %, tol 5e-5).
// Le candidat n'est jamais mesuré sur BTC (contamination).
const replayV1Control = async (
  productId: string,
  year: number,
): Promise<{ ret: number; dd: number } | { code: string }> => {
  const product = createProductId(productId);
  if (!product.ok) return { code: "INVALID_PRODUCT_ID" };
  const dataset = await loadCoinbaseHistoricalDataset({
    productId: product.value,
    timeframe: "ONE_DAY",
    startAt: windowStart(year),
    endAt: windowStart(year + 1),
  });
  if (!dataset.ok) return { code: dataset.error.code };
  const candles = dataset.value.candles as readonly Candle[];
  const registry = createStrategyRegistry(ensembleStrategies(1_000));
  if (!registry.ok) throw new Error(JSON.stringify(registry.error));
  const prepared = await prepareBacktestIndicators(candles, DEFAULT_INDICATOR_CONFIG);
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const config: BacktestConfig = {
    intervalMs: TIMEFRAME_MILLISECONDS["ONE_DAY"],
    runId: `ht1-ctrl-${productId.replace("-", "").toLowerCase()}-${year}`,
    agentId: "dodash-backtest",
    productId: product.value,
    initialCapital: 10_000,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    indicators: DEFAULT_INDICATOR_CONFIG,
    strategies: registry.value,
    risk: { ...riskConfig },
    broker: { feeBps: 6, slippageBps: 2 },
    protectiveExit: {
      mode: "REGIME_CONDITIONAL",
      bullish: { mode: "NONE" },
      bearish: { mode: "FIXED_BPS", stopLossBps: 300, takeProfitBps: 600 },
      range: { mode: "FIXED_BPS", stopLossBps: 300, takeProfitBps: 600 },
      warmUp: { mode: "FIXED_BPS", stopLossBps: 300, takeProfitBps: 600 },
    },
    regimeFilter: { ...REGIME_FILTER },
  };
  const replay = await replayBacktest(candles, config, prepared.value);
  if (!replay.ok) return { code: replay.error.code };
  return {
    ret: replay.value.metrics.totalReturn,
    dd: replay.value.metrics.maxDrawdown,
  };
};

console.log("\n== INV-T7 : contrôle de câblage BTC (baselines V1, tol 5e-5) ==");
let invT7 = true;
for (const [year, ret, dd] of [
  [2023, 0.0027, 0.0293],
  [2025, 0.0363, 0.0337],
] as const) {
  const outcome = await replayV1Control("BTC-USD", year);
  if ("code" in outcome) {
    console.log(`${year}: ${outcome.code} — contrôle non vérifiable`);
    invT7 = false;
    continue;
  }
  const matches =
    Math.abs(outcome.ret - ret) < 0.000_05 &&
    Math.abs(outcome.dd - dd) < 0.000_05;
  invT7 = invT7 && matches;
  console.log(
    `${year}: ret ${pct(outcome.ret)} (att. ${pct(ret)}) dd ${pct(outcome.dd)} (att. ${pct(dd)}) ${matches ? "OK" : "ÉCART"}`,
  );
}
console.log(`INV-T7 : ${invT7 ? "PASS" : "FAIL"}`);

console.log("\n== Phase 2 : campagne (produits sélectionnés, candidat solo) ==");
interface ProductResult {
  readonly productId: string;
  readonly folds: readonly FoldResult[];
  readonly eliminated: readonly { year: number; code: string }[];
}
const productResults: ProductResult[] = [];
for (const product of SELECTED) {
  const folds: FoldResult[] = [];
  const eliminated: { year: number; code: string }[] = [];
  console.log(`\n${product.productId} :`);
  for (const year of START_YEARS) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await replayCandidateWindow(product.productId, year);
    if (!outcome.ok) {
      eliminated.push({ year, code: outcome.code });
      continue;
    }
    folds.push(outcome.fold);
    const f = outcome.fold;
    console.log(
      `  ${f.year} ret ${pct(f.totalReturn).padStart(8)} (B&H ${pct(f.buyHold).padStart(8)}) dd ${pct(f.maxDrawdown).padStart(6)} fills B/S ${f.buyFills}/${f.sellFills} expo ${pct(f.exposure).padStart(6)} détention ${f.avgHoldingDays === null ? "n/a" : `${f.avgHoldingDays.toFixed(0)}j`} net $${f.netPnl.toFixed(2)}`,
    );
  }
  for (const e of eliminated) console.log(`  ${e.year}: ÉLIMINÉE (${e.code})`);
  productResults.push({ productId: product.productId, folds, eliminated });
}

// ---------- Phase 3 : portes G1-G6 et verdict ----------

console.log("\n== Phase 3 : portes par produit (§7) ==");
interface GateRow {
  readonly productId: string;
  readonly folds: number;
  readonly positiveFolds: number;
  readonly medianReturn: number;
  readonly profitFactor: number | null;
  readonly expectancy: number | null;
  readonly worstDd: number;
  readonly passed: boolean;
  readonly gateFlags: readonly string[];
}

const gateRows: GateRow[] = productResults.map((product) => {
  const { folds } = product;
  const n = folds.length;
  const positiveFolds = folds.filter((f) => f.totalReturn > 0).length;
  const medianReturn = n > 0 ? median(folds.map((f) => f.totalReturn)) : Number.NaN;
  const grossWin = folds.reduce((s, f) => s + f.grossWin, 0);
  const grossLoss = folds.reduce((s, f) => s + f.grossLoss, 0);
  const profitFactor =
    grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Number.POSITIVE_INFINITY : null;
  const netPnl = folds.reduce((s, f) => s + f.netPnl, 0);
  const closed = folds.reduce((s, f) => s + f.closedTrades, 0);
  const expectancy = closed > 0 ? netPnl / closed : null;
  const worstDd = n > 0 ? Math.max(...folds.map((f) => f.maxDrawdown)) : Number.NaN;
  const flags: string[] = [];
  const g1 = n >= 4;
  // G2 : compte fixe ≥ 3 folds positifs (miroir exact production-launch
  // condition 3 — pas un ratio), cf. modèle §7.
  const g2 = n >= 4 && positiveFolds >= 3;
  const g3 = n > 0 && medianReturn > 0;
  const g4 = profitFactor !== null && profitFactor > 1;
  const g5 = expectancy !== null && expectancy > 0;
  const g6 = n > 0 && worstDd <= 0.1;
  if (!g1) flags.push("G1");
  if (!g2) flags.push("G2");
  if (!g3) flags.push("G3");
  if (!g4) flags.push("G4");
  if (!g5) flags.push("G5");
  if (!g6) flags.push("G6");
  return {
    productId: product.productId,
    folds: n,
    positiveFolds,
    medianReturn,
    profitFactor,
    expectancy,
    worstDd,
    passed: g1 && g2 && g3 && g4 && g5 && g6,
    gateFlags: flags,
  };
});

for (const row of gateRows) {
  console.log(
    `${row.productId}: folds ${row.folds} (G1 ${row.folds >= 4 ? "P" : "F"}) | positifs ${row.positiveFolds}/${row.folds} (G2 ${row.folds >= 4 && row.positiveFolds >= 3 ? "P" : "F"}) | médiane ${Number.isFinite(row.medianReturn) ? pct(row.medianReturn) : "n/a"} (G3 ${row.medianReturn > 0 ? "P" : "F"}) | PF $ ${row.profitFactor === null ? "n/a" : row.profitFactor.toFixed(2)} (G4 ${row.profitFactor !== null && row.profitFactor > 1 ? "P" : "F"}) | esp/trade $${row.expectancy?.toFixed(2) ?? "n/a"} (G5 ${row.expectancy !== null && row.expectancy > 0 ? "P" : "F"}) | dd max ${Number.isFinite(row.worstDd) ? pct(row.worstDd) : "n/a"} (G6 ${row.worstDd <= 0.1 ? "P" : "F"}) → ${row.passed ? "PASS" : `FAIL [${row.gateFlags.join(",")}]`}`,
  );
}

const allFolds = productResults.flatMap((p) => p.folds.map((f) => f.totalReturn));
const pooledWin = productResults.reduce((s, p) => s + p.folds.reduce((x, f) => x + f.grossWin, 0), 0);
const pooledLoss = productResults.reduce(
  (s, p) => s + p.folds.reduce((x, f) => x + f.grossLoss, 0),
  0,
);
const poolMedian = allFolds.length > 0 ? median(allFolds) : Number.NaN;
const poolPf = pooledLoss > 0 ? pooledWin / pooledLoss : pooledWin > 0 ? Number.POSITIVE_INFINITY : null;
const passing = gateRows.filter((g) => g.passed).length;
const pooledClosed = productResults.reduce(
  (s, p) => s + p.folds.reduce((x, f) => x + f.closedTrades, 0),
  0,
);
const eff1 = pooledClosed >= 8;

// Lecture consignée hors critères (§7).
const geo = (rets: readonly number[]): number =>
  rets.reduce((acc, r) => acc * (1 + r), 1) ** (1 / rets.length) - 1;
console.log("\n== Lectures consignées hors critères ==");
for (const product of productResults) {
  const rets = product.folds.map((f) => f.totalReturn);
  const bh = product.folds.map((f) => f.buyHold).filter((v) => Number.isFinite(v));
  const fees = product.folds.reduce((s, f) => s + f.fees, 0);
  const exposure = product.folds.reduce((s, f) => s + f.exposure, 0) / Math.max(1, product.folds.length);
  console.log(
    `${product.productId}: géom. annualisé ${rets.length > 0 ? pct(geo(rets)) : "n/a"} | B&H médian ${bh.length > 0 ? pct(median(bh)) : "n/a"} | sans-risque ${pct(RISK_FREE_ANNUAL)} | frais $${fees.toFixed(2)} | exposition moy. ${pct(exposure)} | éliminées ${product.eliminated.length}`,
  );
}
const pooledBh = productResults
  .flatMap((p) => p.folds.map((f) => f.buyHold))
  .filter((v) => Number.isFinite(v));
if (pooledBh.length > 0 && Number.isFinite(poolMedian)) {
  const bhMedian = median(pooledBh);
  console.log(
    `pool : médiane candidat ${pct(poolMedian)} vs B&H ${pct(bhMedian)} ${poolMedian >= bhMedian ? "(≥ B&H)" : "(< B&H — capture de bêta dominante si VALIDÉ, règle §7)"} | sans-risque ${pct(RISK_FREE_ANNUAL)}`,
  );
}

console.log("\n== Verdict H-T1 (§7) ==");
console.log(
  `EFF1 : ${pooledClosed} trades clôturés poolés (≥ 8 requis) → ${eff1 ? "PASS" : "FAIL"} | INV-T7 ${invT7 ? "P" : "F"} | produits PASS : ${passing}/${gateRows.length} (≥ 2 requis) | pool : médiane ${Number.isFinite(poolMedian) ? pct(poolMedian) : "n/a"} (> 0 requis), PF $ ${poolPf === null ? "n/a" : poolPf.toFixed(2)} (> 1 requis)`,
);
if (!eff1) {
  console.log(
    "CAMPAGNE INVALIDE (EFF1) — signal inert : pas un verdict sur l'edge ; le candidat n'est pas mesurable sous cette forme (H-T0 sans objet, K1/K3 demeurent).",
  );
} else {
  const verdict = invT7 && passing >= 2 && poolMedian > 0 && poolPf !== null && poolPf > 1;
  console.log(`VERDICT H-T1 : ${verdict ? "VALIDÉ" : "DÉCLASSÉ"}`);
  if (verdict) {
    console.log(
      "Rappel §8 : un VALIDÉ ne déploie rien — suite unique autorisée : nouveau cycle Model pour l'intégration (remplacement rsi-reversion / politique live candidate), à son propre pré-enregistrement.",
    );
  } else {
    console.log(
      "H-T0 retenue → branche 5 fermée sur ce candidat ; K1/K3 demeurent : la conclusion « pas de rentabilité démontrable » se renforce d'un point d'évidence de plus.",
    );
  }
}
