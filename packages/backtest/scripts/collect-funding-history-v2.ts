// Campagne DAO #35 — phase B : collecte de la fenêtre OUT-OF-SAMPLE
// (models/funding-edge-campaign.md §B v2). Lecture-seule : aucune
// permission, aucun code de trading. La fenêtre OOS commence à la fin
// exacte du dataset campagne-1 (dao30 — jamais vue en phase A) et se
// termine au dernier minuit UTC écoulé à l'instant de collecte. Bornes de
// la couture #27/#30 réutilisées à l'identique : réponse ≤ 1 MiB,
// timeout 10 s, coercition chaîne→nombre, toute lecture hors spec rejette
// la collecte entière — jamais de zéro substitué (INV-C3).
// Exécution : npx tsx packages/backtest/scripts/collect-funding-history-v2.ts
// (uniquement APRÈS le commit du protocole v2 — INV-C1 : l'historique git
// doit montrer l'antériorité du protocole sur cette collecte.)

import { mkdir, writeFile } from "node:fs/promises";

import { createProductId, type Candle } from "@dodash/domain";

import { loadCoinbaseHistoricalDataset } from "../src/coinbase-history.js";

// Début OOS = fin exacte du dataset campagne-1 (contiguïté, constante
// figée par l'annexe de calibration : constantesPhaseB.oosStartAt).
const OOS_START = Date.parse("2026-09-01T00:00:00Z");
const DAY = 86_400_000;
// Fin OOS : dernier minuit UTC écoulé (alignement §2 v1) — seules des
// bougies complètes sont collectées.
const OOS_END = Math.floor(Date.now() / DAY) * DAY;
const FUNDING_COIN = "BTC";
const PRICE_PRODUCT = createProductId("BTC-USD");
if (!PRICE_PRODUCT.ok) throw new Error("produit prix invalide");
if (OOS_END <= OOS_START) {
  throw new Error("fenêtre OOS vide — collecte impossible");
}

// Bornes #27/#30 (apps/agent/src/hyperliquid-execution.ts) — identiques
// à la campagne v1 (collect-funding-history.ts), cf. ce fichier pour le
// détail des règles de pagination et de la gigue milliseconde.
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 10_000;
const INFO_ENDPOINT = "https://api.hyperliquid.xyz/info";
const MAX_PAGES = 40;
const HOUR = 3_600_000;

const FIXTURES_DIR = "packages/backtest/fixtures";

const coercitionNumerique = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

interface FundingSample {
  readonly time: number;
  readonly fundingRate: number;
}

const sha256File = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const collectFundingHistory = async (): Promise<{
  readonly samples: readonly FundingSample[];
  readonly requestCount: number;
}> => {
  const samples: FundingSample[] = [];
  let cursor = OOS_START;
  let requestCount = 0;
  while (cursor < OOS_END) {
    if (requestCount >= MAX_PAGES) {
      throw new Error("plafond de pages dépassé — collecte incomplète");
    }
    let response: Response;
    try {
      response = await fetch(INFO_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "fundingHistory",
          coin: FUNDING_COIN,
          startTime: cursor,
          endTime: OOS_END,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new Error(`réseau funding indisponible: ${String(cause)}`);
    }
    requestCount += 1;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`funding HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("réponse funding au-delà du plafond 1 MiB");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("réponse funding non JSON");
    }
    if (!Array.isArray(parsed)) throw new Error("réponse funding hors spec");
    let lastTime: number | null = null;
    for (const entry of parsed) {
      const time = coercitionNumerique(
        (entry as { time?: unknown } | null)?.time,
      );
      const rate = coercitionNumerique(
        (entry as { fundingRate?: unknown } | null)?.fundingRate,
      );
      if (time === null || rate === null) {
        throw new Error("échantillon funding hors spec — rejet entier");
      }
      if (time < cursor || time >= OOS_END) {
        throw new Error(`échantillon funding hors fenêtre: ${time}`);
      }
      const previous = samples.at(-1);
      if (previous !== undefined && time <= previous.time) {
        throw new Error(`échantillon funding non croissant: ${time}`);
      }
      samples.push({ time, fundingRate: rate });
      lastTime = time;
    }
    if (lastTime === null) {
      if (OOS_END - cursor > HOUR) {
        throw new Error(
          `page vide avant la dernière heure (curseur ${cursor}) — trou de données`,
        );
      }
      break;
    }
    cursor = lastTime + 1;
  }
  return { samples, requestCount };
};

// Convention #27 (fundingRatesForCandles) : moyenne des taux observés
// dans [start, start + 24 h) de chaque bougie ; une bougie sans
// observation invalide la collecte (INV-C3).
const dailyRatesForCandles = (
  candles: readonly Candle[],
  samples: readonly FundingSample[],
): readonly number[] => {
  const rates: number[] = [];
  let cursor = 0;
  for (const candle of candles) {
    const end = candle.start + DAY;
    let sum = 0;
    let count = 0;
    while (cursor < samples.length) {
      const sample = samples[cursor];
      if (sample === undefined || sample.time >= end) break;
      if (sample.time >= candle.start) {
        sum += sample.fundingRate;
        count += 1;
      }
      cursor += 1;
    }
    if (count === 0) {
      throw new Error(`bougie ${candle.start} sans observation funding`);
    }
    rates.push(sum / count);
  }
  return rates;
};

const writeWithProvenance = async (
  dataPath: string,
  provenancePath: string,
  data: unknown,
  provenance: Record<string, unknown>,
): Promise<string> => {
  const dataBytes = new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`);
  const sha256 = await sha256File(dataBytes);
  await writeFile(dataPath, dataBytes);
  const provenanceBytes = new TextEncoder().encode(
    `${JSON.stringify({ ...provenance, sha256 }, null, 2)}\n`,
  );
  await writeFile(provenancePath, provenanceBytes);
  return sha256;
};

const main = async (): Promise<void> => {
  const funding = await collectFundingHistory();

  const price = await loadCoinbaseHistoricalDataset({
    productId: PRICE_PRODUCT.value,
    timeframe: "ONE_DAY",
    startAt: OOS_START,
    endAt: OOS_END,
  });
  if (!price.ok) {
    throw new Error(`chargement bougies Coinbase impossible: ${price.error.code}`);
  }
  const candles: readonly Candle[] = price.value.candles;

  // Couverture journalière validée avant toute écriture (fail-closed).
  const dailyRates = dailyRatesForCandles(candles, funding.samples);
  if (dailyRates.length !== candles.length) {
    throw new Error("série de coût journalière désalignée des bougies");
  }

  await mkdir(FIXTURES_DIR, { recursive: true });

  const fundingSha = await writeWithProvenance(
    `${FIXTURES_DIR}/dao35-funding-btc-oos.json`,
    `${FIXTURES_DIR}/dao35-funding-btc-oos.provenance.json`,
    {
      coin: FUNDING_COIN,
      startTime: OOS_START,
      endTime: OOS_END,
      samples: funding.samples,
    },
    {
      dataset: "dao35-funding-btc-oos",
      endpoint: INFO_ENDPOINT,
      request: 'POST /info { type: "fundingHistory", coin, startTime, endTime }',
      coin: FUNDING_COIN,
      window: { startAt: OOS_START, endAt: OOS_END },
      collectedAt: new Date().toISOString(),
      recordCount: funding.samples.length,
      requestCount: funding.requestCount,
      bounded: { maxResponseBytes: MAX_RESPONSE_BYTES, timeoutMs: REQUEST_TIMEOUT_MS },
      protocol: "models/funding-edge-campaign.md §B (v2, DAO #35)",
    },
  );

  const priceSha = await writeWithProvenance(
    `${FIXTURES_DIR}/dao35-price-btc-usd-oos.json`,
    `${FIXTURES_DIR}/dao35-price-btc-usd-oos.provenance.json`,
    {
      source: "coinbase",
      productId: PRICE_PRODUCT.value,
      timeframe: "ONE_DAY",
      startAt: OOS_START,
      endAt: OOS_END,
      candles,
    },
    {
      dataset: "dao35-price-btc-usd-oos",
      endpoint: price.value.endpoint,
      productId: PRICE_PRODUCT.value,
      timeframe: "ONE_DAY",
      window: { startAt: OOS_START, endAt: OOS_END },
      collectedAt: new Date().toISOString(),
      candleCount: candles.length,
      loaderDatasetSha256: price.value.sha256,
      protocol: "models/funding-edge-campaign.md §B (v2, DAO #35)",
    },
  );

  const first = candles[0];
  const last = candles.at(-1);
  console.log(
    JSON.stringify(
      {
        status: "COLLECTED",
        window: { startAt: OOS_START, endAt: OOS_END, days: candles.length },
        funding: {
          records: funding.samples.length,
          requests: funding.requestCount,
          sha256: fundingSha,
        },
        price: {
          candles: candles.length,
          firstStart: first?.start,
          lastStart: last?.start,
          sha256: priceSha,
        },
        dailyRates: dailyRates.length,
        fixturesDir: FIXTURES_DIR,
      },
      null,
      2,
    ),
  );
};

await main();
