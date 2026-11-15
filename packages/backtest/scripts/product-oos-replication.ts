// Campagne H-D1 — models/product-oos-replication.md (pré-enregistré a priori).
// Phase 1 découverte NON économique : listing public Coinbase (champs
// product_id/status/quote_currency_id/volume_24h uniquement — jamais le
// prix), sonde 5/5 candles ONE_DAY au départ de chacune des 10 fenêtres
// annuelles, exclusions fail-closed (§2.1), sélection gelée (fenêtres
// présentes desc, volume_24h desc, product_id asc → 4 produits).
// Phase 2 campagne : par produit, chargement complet + UN replay V1-IDENTITY
// bit-identique D3-P2 C0 par fenêtre présente. Contrôle INV-R5 BTC.
// Phase 3 portes G1-G6 par produit + verdict global (§4).
// Exécution : node --experimental-strip-types scripts/product-oos-replication.ts
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
  type Strategy,
} from "@dodash/domain";
import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import {
  createBreakoutStrategy,
  createEmaCrossStrategy,
  createRsiReversionStrategy,
  createStrategyRegistry,
} from "@dodash/strategies";

// §2.1 — exclusions fail-closed, append-only.
const CONSULTED = new Set([
  "BTC", "ETH", "LTC", "SOL", "ATOM", "ETC", "ALGO", "FIL", "GRT", "MANA",
  "XTZ", "ZEC", "ADA", "DOGE", "AAVE", "XLM", "LINK", "AVAX", "BCH", "UNI",
]);
const STABLECOINS = new Set([
  "USDC", "USDT", "DAI", "PYUSD", "TUSD", "GUSD", "FDUSD", "USDS", "FRAX",
]);
const WRAPPED = new Set([
  "WBTC", "WETH", "cbBTC", "cbETH", "wstETH", "weETH", "rETH", "stETH",
]);

const START_YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] as const;
const DAY = 86_400_000;
const BASE_URL = "https://api.coinbase.com";

const windowStart = (year: number): number => {
  const t = Date.parse(`${year}-08-21T00:00:00Z`);
  if (Number.isNaN(t) || t % DAY !== 0) throw new Error(`unaligned ${year}`);
  return t;
};

const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 === 1
    ? s[(s.length - 1) / 2]!
    : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

const fetchJson = async (url: string, attempt = 0): Promise<unknown> => {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    return JSON.parse(await response.text()) as unknown;
  } catch (error) {
    if (attempt >= 2) throw error;
    await new Promise((resolve) => setTimeout(resolve, 800));
    return fetchJson(url, attempt + 1);
  }
};

// ---------- Phase 1 : découverte (non économique) ----------

interface Candidate {
  readonly productId: string;
  readonly volume24h: number | null;
}

console.log("== Phase 1 : découverte (aucune métrique de performance lue) ==");

// Listing paginé, product_type=SPOT — itération jusqu'à épuisement.
const fetchAllSpotProducts = async (): Promise<unknown[]> => {
  const all: unknown[] = [];
  const limit = 250;
  for (let offset = 0; ; offset += limit) {
    const url = `${BASE_URL}/api/v3/brokerage/market/products?product_type=SPOT&limit=${limit}&offset=${offset}`;
    // eslint-disable-next-line no-await-in-loop
    const payload = (await fetchJson(url)) as { products?: unknown };
    if (!Array.isArray(payload.products)) break;
    all.push(...payload.products);
    if (payload.products.length < limit) break;
  }
  return all;
};

const productsEntries = await fetchAllSpotProducts();

const candidates: Candidate[] = [];
let excludedConsulted = 0;
let excludedStable = 0;
let excludedWrapped = 0;
let excludedOther = 0;
for (const entry of productsEntries) {
  if (typeof entry !== "object" || entry === null) continue;
  const record = entry as Record<string, unknown>;
  const productId = record.product_id;
  const status = record.status;
  const quote = record.quote_currency_id;
  if (
    typeof productId !== "string" ||
    typeof status !== "string" ||
    typeof quote !== "string" ||
    status !== "online" ||
    quote !== "USD" ||
    !productId.endsWith("-USD")
  ) {
    excludedOther += 1;
    continue;
  }
  const base = productId.slice(0, -"-USD".length);
  if (CONSULTED.has(base)) {
    excludedConsulted += 1;
    continue;
  }
  if (STABLECOINS.has(base)) {
    excludedStable += 1;
    continue;
  }
  if (WRAPPED.has(base)) {
    excludedWrapped += 1;
    continue;
  }
  const volumeRaw = record.volume_24h;
  const volumeParsed =
    typeof volumeRaw === "number"
      ? volumeRaw
      : typeof volumeRaw === "string" && volumeRaw.trim() !== ""
        ? Number.parseFloat(volumeRaw)
        : Number.NaN;
  candidates.push({
    productId,
    volume24h: Number.isFinite(volumeParsed) ? volumeParsed : null,
  });
}
console.log(
  `listing SPOT : ${productsEntries.length} produits ; ${candidates.length} candidats USD/online hors exclusions (consultés ${excludedConsulted}, stables ${excludedStable}, empaquetés ${excludedWrapped}, statut/quote/autre ${excludedOther})`,
);

// Sonde 5/5 par fenêtre — présence seule, aucun prix/rendement lu.
const probeWindow = async (productId: string, t0: number): Promise<boolean> => {
  const url = new URL(
    `${BASE_URL}/api/v3/brokerage/market/products/${encodeURIComponent(productId)}/candles`,
  );
  url.searchParams.set("start", String(t0 / 1_000));
  url.searchParams.set("end", String((t0 + 4 * DAY) / 1_000));
  url.searchParams.set("granularity", "ONE_DAY");
  url.searchParams.set("limit", "5");
  const payload = await fetchJson(url.href).catch(() => null);
  if (payload === null) return false;
  const candles = (payload as { candles?: unknown }).candles;
  if (!Array.isArray(candles) || candles.length !== 5) return false;
  const starts = new Set<number>();
  for (const candle of candles) {
    if (typeof candle !== "object" || candle === null) return false;
    const start = (candle as Record<string, unknown>).start;
    if (typeof start !== "number" && typeof start !== "string") return false;
    starts.add(Number(start));
  }
  for (let i = 0; i < 5; i += 1) {
    if (!starts.has((t0 + i * DAY) / 1_000)) return false;
  }
  return true;
};

interface Probed {
  readonly productId: string;
  readonly present: number;
  readonly volume24h: number | null;
}

const probed: Probed[] = [];
let probeIndex = 0;
for (const candidate of candidates) {
  probeIndex += 1;
  let present = 0;
  for (const year of START_YEARS) {
    // eslint-disable-next-line no-await-in-loop
    if (await probeWindow(candidate.productId, windowStart(year))) present += 1;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  probed.push({ productId: candidate.productId, present, volume24h: candidate.volume24h });
  if (probeIndex % 25 === 0) console.log(`  sonde ${probeIndex}/${candidates.length}...`);
}

const eligible = probed.filter((c) => c.present >= 5);
console.log(
  `\nsondes : ${probed.length} produits ; éligibles (≥ 5 fenêtres présentes) : ${eligible.length}`,
);
for (const c of [...eligible].sort((a, b) => b.present - a.present).slice(0, 12)) {
  console.log(`  ${c.productId.padEnd(14)} fenêtres ${c.present}/10  vol24h ${c.volume24h ?? "n/a"}`);
}

// §2.2 sélection — fonction pure gelée (fenêtres desc, volume desc, id asc).
const selected = [...eligible]
  .sort((a, b) => {
    if (b.present !== a.present) return b.present - a.present;
    const va = a.volume24h ?? -1;
    const vb = b.volume24h ?? -1;
    if (vb !== va) return vb - va;
    return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;
  })
  .slice(0, 4);
console.log("\nSÉLECTION GELÉE (INV-R2) :");
for (const c of selected)
  console.log(`  ${c.productId} (fenêtres présentes ${c.present}/10, vol24h ${c.volume24h ?? "n/a"})`);

// ---------- Phase 2 : campagne ----------

const ensembleStrategies = (targetNotional: number): readonly Strategy[] => {
  const size = (s: Strategy): Strategy => withTargetSignalNotional(s, targetNotional);
  const calibrate = (s: Strategy): Strategy => withConfidenceCalibration(s, "IDENTITY");
  return [
    size(createRsiReversionStrategy({ oversold: 30, overbought: 70, baseSize: targetNotional })),
    size(calibrate(createEmaCrossStrategy({ baseSize: targetNotional }))),
    size(calibrate(createBreakoutStrategy({ lookback: 20, baseSize: targetNotional }))),
  ];
};

interface FoldResult {
  readonly year: number;
  readonly totalReturn: number;
  readonly maxDrawdown: number;
  readonly closedTrades: number;
  readonly netPnl: number;
  readonly grossWin: number;
  readonly grossLoss: number;
}

type WindowOutcome =
  | { ok: false; code: string }
  | { ok: true; fold: FoldResult };

const replayWindow = async (productId: string, year: number): Promise<WindowOutcome> => {
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
  const registry = createStrategyRegistry(ensembleStrategies(1_000));
  if (!registry.ok) throw new Error(JSON.stringify(registry.error));
  const prepared = await prepareBacktestIndicators(candles, DEFAULT_INDICATOR_CONFIG);
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const config: BacktestConfig = {
    intervalMs: TIMEFRAME_MILLISECONDS["ONE_DAY"],
    runId: `hd1-${productId.replace("-", "").toLowerCase()}-${year}`,
    agentId: "dodash-backtest",
    productId: product.value,
    initialCapital: 10_000,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    indicators: DEFAULT_INDICATOR_CONFIG,
    strategies: registry.value,
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
  };
  const replay = await replayBacktest(candles, config, prepared.value);
  if (!replay.ok) return { ok: false, code: replay.error.code };
  const closed = replay.value.trades.filter((t) => t.closedQuantity > 0);
  const grossWin = closed.reduce((s, t) => s + Math.max(t.realizedPnl, 0), 0);
  const grossLoss = closed.reduce((s, t) => s + Math.max(-t.realizedPnl, 0), 0);
  return {
    ok: true,
    fold: {
      year,
      totalReturn: replay.value.metrics.totalReturn,
      maxDrawdown: replay.value.metrics.maxDrawdown,
      closedTrades: closed.length,
      netPnl: replay.value.metrics.pnl,
      grossWin,
      grossLoss,
    },
  };
};

// INV-R5 — contrôle de câblage BTC (mêmes fonctions, jamais mesuré).
console.log("\n== INV-R5 : contrôle de câblage BTC (baselines V1, tol 5e-5) ==");
let invR5 = true;
for (const [year, ret, dd] of [
  [2023, 0.0027, 0.0293],
  [2025, 0.0363, 0.0337],
] as const) {
  const outcome = await replayWindow("BTC-USD", year);
  if (!outcome.ok) {
    console.log(`${year}: ${outcome.code} — contrôle non vérifiable`);
    invR5 = false;
    continue;
  }
  const matches =
    Math.abs(outcome.fold.totalReturn - ret) < 0.000_05 &&
    Math.abs(outcome.fold.maxDrawdown - dd) < 0.000_05;
  invR5 = invR5 && matches;
  console.log(
    `${year}: ret ${pct(outcome.fold.totalReturn)} (att. ${pct(ret)}) dd ${pct(outcome.fold.maxDrawdown)} (att. ${pct(dd)}) ${matches ? "OK" : "ÉCART"}`,
  );
}
console.log(`INV-R5 : ${invR5 ? "PASS" : "FAIL"}`);

console.log("\n== Phase 2 : campagne (produits sélectionnés) ==");
interface ProductResult {
  readonly productId: string;
  readonly folds: readonly FoldResult[];
  readonly eliminated: readonly { year: number; code: string }[];
}
const productResults: ProductResult[] = [];
for (const product of selected) {
  const folds: FoldResult[] = [];
  const eliminated: { year: number; code: string }[] = [];
  console.log(`\n${product.productId} :`);
  for (const year of START_YEARS) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await replayWindow(product.productId, year);
    if (!outcome.ok) {
      eliminated.push({ year, code: outcome.code });
      continue;
    }
    folds.push(outcome.fold);
    const f = outcome.fold;
    console.log(
      `  ${f.year} ret ${pct(f.totalReturn).padStart(8)} dd ${pct(f.maxDrawdown).padStart(6)} trades ${f.closedTrades} net $${f.netPnl.toFixed(2)}`,
    );
  }
  for (const e of eliminated) console.log(`  ${e.year}: ÉLIMINÉE (${e.code})`);
  productResults.push({ productId: product.productId, folds, eliminated });
}

// ---------- Phase 3 : portes G1-G6 et verdict ----------

console.log("\n== Phase 3 : portes par produit (§4) ==");
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
  // condition 3 — pas un ratio), cf. modèle §4.
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

// Lecture hors critères (§4) : géométrique annualisé par produit.
const geo = (rets: readonly number[]): number =>
  rets.reduce((acc, r) => acc * (1 + r), 1) ** (1 / rets.length) - 1;
console.log("\n== Lecture consignée hors critères ==");
for (const product of productResults) {
  const rets = product.folds.map((f) => f.totalReturn);
  const geoAnnual =
    rets.length > 0 ? geo(rets) * (rets.length >= 2 ? 1 : 1) : Number.NaN;
  console.log(
    `${product.productId}: géométrique annualisé (moyenne sur ${rets.length} fenêtres) ${Number.isFinite(geoAnnual) ? pct(geoAnnual) : "n/a"} | éliminées ${product.eliminated.length}`,
  );
}

console.log("\n== Verdict H-D1 (§4) ==");
console.log(
  `produits PASS : ${passing}/${gateRows.length} (≥ 2 requis) | pool : médiane ${Number.isFinite(poolMedian) ? pct(poolMedian) : "n/a"} (> 0 requis), PF $ ${poolPf === null ? "n/a" : poolPf.toFixed(2)} (> 1 requis)`,
);
const verdict = invR5 && passing >= 2 && poolMedian > 0 && poolPf !== null && poolPf > 1;
console.log(`VERDICT H-D1 : ${verdict ? "VALIDÉ" : "DÉCLASSÉ"} (INV-R5 ${invR5 ? "P" : "F"})`);
if (!verdict) {
  console.log(
    "H-D0 retenue → K1 : la voie « bot autonome rentable » (V1) est fermée ; priorité H-S1a (découplage EMAs).",
  );
} else {
  console.log(
    "Rappel §9 : un VALIDÉ ne déploie rien et n'ouvre aucune porte production-launch — il motive au mieux une nouvelle politique live candidate à son propre cycle.",
  );
}
