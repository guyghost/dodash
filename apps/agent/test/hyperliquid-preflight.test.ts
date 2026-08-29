import { describe, expect, it, vi } from "vitest";

import { runHyperliquidPreflight } from "../src/hyperliquid-preflight.js";
import type { HyperliquidMeta } from "../src/hyperliquid-execution.js";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const meta = (entries: HyperliquidMeta["universe"]): HyperliquidMeta => ({
  universe: entries,
});

describe("runHyperliquidPreflight", () => {
  it("passe quand la méta confirme l'enveloppe figée", () => {
    const result = runHyperliquidPreflight(
      meta([
        { name: "BTC", szDecimals: 5, maxLeverage: 40 },
        { name: "ETH", szDecimals: 4, maxLeverage: 25 },
      ]),
    );
    expect(result).toEqual({ ok: true });
  });

  it("échoue fermé sur une méta absente ou hors spec", () => {
    for (const broken of [null, meta([]), { universe: "BTC" } as unknown as HyperliquidMeta]) {
      const result = runHyperliquidPreflight(broken);
      expect(result.ok).toBe(false);
    }
  });

  it("signale un marché manquant", () => {
    const result = runHyperliquidPreflight(
      meta([{ name: "ETH", szDecimals: 4, maxLeverage: 25 }]),
    );
    expect(result).toEqual({
      ok: false,
      findings: [
        {
          productId: "BTC-PERP",
          code: "HYPERLIQUID_MARKET_MISSING",
          expected: "BTC",
          actual: null,
        },
      ],
    });
  });

  it("signale un écart de szDecimals avec l'enveloppe", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        universe: [
          { name: "BTC", szDecimals: 3, maxLeverage: 40 },
          { name: "ETH", szDecimals: 4, maxLeverage: 25 },
        ],
      }),
    );
    const { fetchHyperliquidMeta } = await import("../src/hyperliquid-execution.js");
    const { HYPERLIQUID_PRODUCTION_URL } = await import(
      "../src/hyperliquid-settings.js"
    );
    const settings = {
      apiBaseUrl: HYPERLIQUID_PRODUCTION_URL,
      agentPrivateKey:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      walletAddress: "0x2222222222222222222222222222222222222222",
      isTestnet: false,
    };
    const fetched = await fetchHyperliquidMeta(settings, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = runHyperliquidPreflight(fetched);
    expect(result).toEqual({
      ok: false,
      findings: [
        {
          productId: "BTC-PERP",
          code: "HYPERLIQUID_SIZE_DECIMALS_MISMATCH",
          expected: 5,
          actual: 3,
        },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${HYPERLIQUID_PRODUCTION_URL}/info`);
    expect((JSON.parse(String(init.body)) as Record<string, unknown>).type).toBe(
      "meta",
    );
  });

  it("signale un levier réel inférieur à l'enveloppe", () => {
    const result = runHyperliquidPreflight(
      meta([
        { name: "BTC", szDecimals: 5, maxLeverage: 1 },
        { name: "ETH", szDecimals: 4, maxLeverage: 25 },
      ]),
    );
    expect(result).toEqual({
      ok: false,
      findings: [
        {
          productId: "BTC-PERP",
          code: "HYPERLIQUID_LEVERAGE_CAP_UNAVAILABLE",
          expected: 2,
          actual: 1,
        },
      ],
    });
  });
});
