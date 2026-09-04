// Campagne DAO #30 — collecte du dataset (models/funding-edge-campaign.md §3).
// Lecture-seule : ce script ne touche aucun code de trading, aucune
// permission ; il collecte, valide et persiste des fixtures versionnées.
// Bornes de la couture #27 (apps/agent/src/hyperliquid-execution.ts)
// réutilisées à l'identique : réponse ≤ 1 MiB, timeout 10 s, coercition
// chaîne→nombre, toute lecture hors spec rejette la collecte entière —
// jamais de zéro substitué (INV-C3). Exécution : npx tsx
// packages/backtest/scripts/collect-funding-history.ts

import { mkdir, writeFile } from "node:fs/promises";

import { createProductId, type Candle } from "@dodash/domain";

import { loadCoinbaseHistoricalDataset } from "../src/coinbase-history.js";

// Fenêtres figées par le protocole (models/funding-edge-campaign.md §2) —
// INV-C1 : aucune retouche après observation.
const H12_START = Date.parse("2025-09-01T00:00:00Z");
const H12_END = Date.parse("2026-09-01T00:00:00Z");
const DAY = 86_400_000;
const FUNDING_COIN = "BTC";
const PRICE_PRODUCT = createProductId("BTC-USD");
if (!PRICE_PRODUCT.ok) throw new Error("produit prix invalide");

// Bornes #27 (apps/agent/src/hyperliquid-execution.ts).
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 10_000;
const INFO_ENDPOINT = "https://api.hyperliquid.xyz/info";
// fundingHistory retourne au plus ~500 enregistrements par appel ;
// 8 760 heures ⇒ ~18 pages. Cap dur anti-boucle. Une page vide est un
// échec fermé sauf dans la dernière heure de la fenêtre : les instants
// de funding portent une gigue milliseconde (ex. 23:00:00.129Z), donc
// l'intervalle (dernier échantillon, fin] peut légitimement être vide ;
// un stall avant ⇒ trou de données réel (INV-C3 : jamais de fenêtre
// compressée). La couverture journalière est de toute façon validée
// bougie par bougie avant écriture.
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
  let cursor = H12_START;
  let requestCount = 0;
  while (cursor < H12_END) {
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
          endTime: H12_END,
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
      if (time < cursor || time >= H12_END) {
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
      if (H12_END - cursor > HOUR) {
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

const collectedAt = (): string => new Date().toISOString();

const main = async (): Promise<void> => {
  const funding = await collectFundingHistory();

  const price = await loadCoinbaseHistoricalDataset({
    productId: PRICE_PRODUCT.value,
    timeframe: "ONE_DAY",
    startAt: H12_START,
    endAt: H12_END,
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
    `${FIXTURES_DIR}/dao30-funding-btc.json`,
    `${FIXTURES_DIR}/dao30-funding-btc.provenance.json`,
    {
      coin: FUNDING_COIN,
      startTime: H12_START,
      endTime: H12_END,
      samples: funding.samples,
    },
    {
      dataset: "dao30-funding-btc",
      endpoint: INFO_ENDPOINT,
      request: 'POST /info { type: "fundingHistory", coin, startTime, endTime }',
      coin: FUNDING_COIN,
      window: { startAt: H12_START, endAt: H12_END },
      collectedAt: collectedAt(),
      recordCount: funding.samples.length,
      requestCount: funding.requestCount,
      bounded: { maxResponseBytes: MAX_RESPONSE_BYTES, timeoutMs: REQUEST_TIMEOUT_MS },
      protocol: "models/funding-edge-campaign.md §3",
    },
  );

  const priceSha = await writeWithProvenance(
    `${FIXTURES_DIR}/dao30-price-btc-usd.json`,
    `${FIXTURES_DIR}/dao30-price-btc-usd.provenance.json`,
    {
      source: "coinbase",
      productId: PRICE_PRODUCT.value,
      timeframe: "ONE_DAY",
      startAt: H12_START,
      endAt: H12_END,
      candles,
    },
    {
      dataset: "dao30-price-btc-usd",
      endpoint: price.value.endpoint,
      productId: PRICE_PRODUCT.value,
      timeframe: "ONE_DAY",
      window: { startAt: H12_START, endAt: H12_END },
      collectedAt: collectedAt(),
      candleCount: candles.length,
      loaderDatasetSha256: price.value.sha256,
      protocol: "models/funding-edge-campaign.md §3",
    },
  );

  const first = candles[0];
  const last = candles.at(-1);
  console.log(
    JSON.stringify(
      {
        status: "COLLECTED",
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
