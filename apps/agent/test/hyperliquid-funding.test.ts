import { describe, expect, it, vi } from "vitest";

import {
  fetchHyperliquidFundingHistory,
  fundingRatesForCandles,
} from "../src/hyperliquid-execution.js";
import { HYPERLIQUID_PRODUCTION_URL } from "../src/hyperliquid-settings.js";

const settings = {
  apiBaseUrl: HYPERLIQUID_PRODUCTION_URL,
  agentPrivateKey:
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  walletAddress: "0x2222222222222222222222222222222222222222",
  isTestnet: false,
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("fetchHyperliquidFundingHistory (models/funding-rate-strategy.md §2)", () => {
  it("lit fundingHistory et type les observations (fundingRate en chaîne numérique)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        { coin: "BTC", fundingRate: "0.00001250", time: 1_000 },
        { coin: "BTC", fundingRate: "-0.00002500", time: 3_600_000 },
      ]),
    );
    const samples = await fetchHyperliquidFundingHistory(
      settings,
      { coin: "BTC", startTime: 1_000 },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(samples).toEqual([
      { time: 1_000, fundingRate: 0.0000125 },
      { time: 3_600_000, fundingRate: -0.000025 },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${HYPERLIQUID_PRODUCTION_URL}/info`);
    expect(JSON.parse(String(init.body))).toEqual({
      type: "fundingHistory",
      coin: "BTC",
      startTime: 1_000,
    });
  });

  it("retourne null sur réseau indisponible, hors spec ou observation partielle (INV-F2)", async () => {
    const broken: ReadonlyArray<typeof fetch> = [
      (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
      (async () => jsonResponse({ nope: true })) as unknown as typeof fetch,
      (async () => jsonResponse("array?" as never)) as unknown as typeof fetch,
      (async () =>
        jsonResponse([{ coin: "BTC", fundingRate: "NaN", time: 1 }])) as unknown as typeof fetch,
      (async () =>
        jsonResponse([{ coin: "BTC", fundingRate: "0.0001", time: "x" }])) as unknown as typeof fetch,
      (async () =>
        jsonResponse([
          { coin: "BTC", fundingRate: "0.0001", time: 5_000 },
          { coin: "BTC", fundingRate: "oops", time: 6_000 },
        ])) as unknown as typeof fetch,
    ];
    for (const fetchMock of broken) {
      expect(
        await fetchHyperliquidFundingHistory(
          settings,
          { coin: "BTC", startTime: 0 },
          { fetch: fetchMock },
        ),
      ).toBeNull();
    }
  });

  it("rejette une requête mal formée sans appel réseau (INV-F2)", async () => {
    const fetchMock = vi.fn();
    expect(
      await fetchHyperliquidFundingHistory(
        settings,
        { coin: "", startTime: -1 },
        { fetch: fetchMock as unknown as typeof fetch },
      ),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fundingRatesForCandles (models/funding-rate-strategy.md §2)", () => {
  const candles = [
    { start: 0 },
    { start: 86_400_000 },
    { start: 172_800_000 },
  ];

  it("agrège 1:1 la moyenne des taux de chaque bougie", () => {
    const rates = fundingRatesForCandles(candles, [
      { time: 1, fundingRate: 0.0001 },
      { time: 2, fundingRate: 0.0003 },
      { time: 86_400_500, fundingRate: -0.0002 },
      { time: 172_800_100, fundingRate: 0.0006 },
    ]);
    expect(rates).not.toBeNull();
    if (rates === null) return;
    expect(rates).toHaveLength(3);
    expect(rates[0]).toBeCloseTo(0.0002, 15);
    expect(rates[1]).toBeCloseTo(-0.0002, 15);
    expect(rates[2]).toBeCloseTo(0.0006, 15);
  });

  it("retourne null si une bougie n'a aucune observation (INV-F2)", () => {
    const rates = fundingRatesForCandles(candles, [
      { time: 1, fundingRate: 0.0001 },
      // pas d'observation dans [86_400_000, 172_800_000)
      { time: 172_800_100, fundingRate: 0.0006 },
    ]);
    expect(rates).toBeNull();
  });

  it("retourne null sans bougies suffisantes pour dériver la granularité", () => {
    expect(fundingRatesForCandles([{ start: 0 }], [])).toBeNull();
    expect(fundingRatesForCandles([], [])).toBeNull();
  });

  it("ignoré : observations antérieures à la première bougie", () => {
    const rates = fundingRatesForCandles(candles, [
      { time: 172_800_100, fundingRate: 0.0006 },
    ]);
    expect(rates).toBeNull();
  });
});
