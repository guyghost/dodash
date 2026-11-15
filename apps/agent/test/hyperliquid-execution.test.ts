import { BASE_URLS, signL1Action as sdkSignL1Action } from "hyperliquid";
import { Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";

import {
  aggressivePrice,
  assetIndexForCoin,
  createEthersSignerFactory,
  derivePerpRiskGate,
  fetchHyperliquidAccountState,
  fetchHyperliquidMeta,
  fetchHyperliquidOrderFills,
  hyperliquidCoin,
  hyperliquidMarketIocOrder,
  reconcileHyperliquidOrder,
  signHyperliquidOrder,
  submitHyperliquidOrder,
  type HyperliquidMeta,
} from "../src/hyperliquid-execution.js";
import { hyperliquidCloidFromClientOrderId } from "../src/hyperliquid-signing.js";
import {
  HYPERLIQUID_PRODUCTION_URL,
  HYPERLIQUID_TESTNET_URL,
  resolveHyperliquidSettings,
} from "../src/hyperliquid-settings.js";
import { hyperliquidActionHash } from "../src/hyperliquid-signing.js";

const AGENT_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const WALLET_ADDRESS = "0x2222222222222222222222222222222222222222";

const settings = {
  apiBaseUrl: HYPERLIQUID_PRODUCTION_URL,
  agentPrivateKey: AGENT_KEY,
  walletAddress: WALLET_ADDRESS,
  isTestnet: false,
};

const INTENT = Object.freeze({
  productId: "BTC-PERP",
  side: "BUY" as const,
  quantity: 0.005,
  markPrice: 100_000,
  leverage: 1,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("resolveHyperliquidSettings", () => {
  it("refuse tout réglage sans flag perp dédié", () => {
    expect(
      resolveHyperliquidSettings({
        HYPERLIQUID_AGENT_PRIVATE_KEY: AGENT_KEY,
        HYPERLIQUID_WALLET_ADDRESS: WALLET_ADDRESS,
      }),
    ).toEqual({ ok: false, error: { code: "HYPERLIQUID_EXECUTION_UNAVAILABLE" } });
  });

  it("refuse clé ou adresse malformée", () => {
    expect(
      resolveHyperliquidSettings({
        HYPERLIQUID_PERP_TRADING_ENABLED: "true",
        HYPERLIQUID_AGENT_PRIVATE_KEY: "0x1234",
        HYPERLIQUID_WALLET_ADDRESS: WALLET_ADDRESS,
      }).ok,
    ).toBe(false);
    expect(
      resolveHyperliquidSettings({
        HYPERLIQUID_PERP_TRADING_ENABLED: "true",
        HYPERLIQUID_AGENT_PRIVATE_KEY: AGENT_KEY,
        HYPERLIQUID_WALLET_ADDRESS: "0x2222",
      }).ok,
    ).toBe(false);
  });

  it("résout les défauts d'URL selon le réseau visé", () => {
    const production = resolveHyperliquidSettings({
      HYPERLIQUID_PERP_TRADING_ENABLED: "true",
      HYPERLIQUID_AGENT_PRIVATE_KEY: AGENT_KEY,
      HYPERLIQUID_WALLET_ADDRESS: WALLET_ADDRESS,
    });
    expect(production.ok).toBe(true);
    if (production.ok) {
      expect(production.value.apiBaseUrl).toBe(BASE_URLS.PRODUCTION);
    }

    const testnet = resolveHyperliquidSettings({
      HYPERLIQUID_PERP_TRADING_ENABLED: "true",
      HYPERLIQUID_AGENT_PRIVATE_KEY: AGENT_KEY,
      HYPERLIQUID_WALLET_ADDRESS: WALLET_ADDRESS,
      HYPERLIQUID_TESTNET: "true",
    });
    expect(testnet.ok).toBe(true);
    if (testnet.ok) {
      expect(testnet.value.apiBaseUrl).toBe(HYPERLIQUID_TESTNET_URL);
      expect(HYPERLIQUID_TESTNET_URL).toBe(BASE_URLS.TESTNET);
    }
  });
});

describe("construction d'ordre marché IOC", () => {
  it("nomme les marchés Hyperliquid depuis l'enveloppe dodash", () => {
    expect(hyperliquidCoin("BTC-PERP")).toBe("BTC");
    expect(hyperliquidCoin("ETH-PERP")).toBe("ETH");
    expect(hyperliquidCoin("SOL-PERP")).toBeNull();
  });

  it("borde le prix d'agression à 5 chiffres significatifs dans le bon sens", () => {
    expect(aggressivePrice(100_000, "BUY")).toBe("100500");
    expect(aggressivePrice(100_000, "SELL")).toBe("99500");
    expect(Number(aggressivePrice(100_000, "BUY"))).toBeGreaterThan(100_000);
    expect(Number(aggressivePrice(100_000, "SELL"))).toBeLessThan(100_000);
  });

  it("rend la taille exacte sans zéros traînants", () => {
    const action = hyperliquidMarketIocOrder(INTENT, 0, "perp-2026-08-28-0001");
    expect(action.orders[0]?.s).toBe("0.005");
    expect(action.orders[0]?.p).toBe("100500");
    expect(action.orders[0]?.b).toBe(true);
    expect(action.orders[0]?.r).toBe(false);
    expect(action.orders[0]?.a).toBe(0);
    expect(action.orders[0]?.t).toEqual({ limit: { tif: "Ioc" } });
    expect(action.grouping).toBe("na");
    expect(Object.keys(action)).toEqual(["type", "orders", "grouping"]);
    expect(Object.keys(action.orders[0] as object)).toEqual([
      "a",
      "b",
      "p",
      "s",
      "r",
      "t",
      "c",
    ]);
  });

  it("produit un cloid déterministe au format 0x + 64 hex", () => {
    const first = hyperliquidCloidFromClientOrderId("perp-2026-08-28-0001");
    const second = hyperliquidCloidFromClientOrderId("perp-2026-08-28-0001");
    expect(first).toBe(second);
    expect(first).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it("indexe l'actif depuis la méta lue", () => {
    const meta: HyperliquidMeta = {
      universe: [
        { name: "BTC", szDecimals: 5, maxLeverage: 40 },
        { name: "ETH", szDecimals: 4, maxLeverage: 25 },
      ],
    };
    expect(assetIndexForCoin(meta, "BTC")).toBe(0);
    expect(assetIndexForCoin(meta, "ETH")).toBe(1);
    expect(assetIndexForCoin(meta, "SOL")).toBeNull();
  });
});

describe("signature Hyperliquid", () => {
  const nonce = 1_756_416_000_000;
  const action = hyperliquidMarketIocOrder(INTENT, 0, "perp-2026-08-28-0001");

  it("est équivalente au SDK de référence pour la même action et nonce", async () => {
    const wallet = new Wallet(AGENT_KEY);
    const ours = await signHyperliquidL1ActionForTest(wallet, action, nonce, true);
    const reference = await sdkSignL1Action(wallet, action, null, nonce, true);
    expect(ours).toEqual(reference);
  });

  it("dépend du nonce : deux nonces donnent deux signatures distinctes", async () => {
    const wallet = new Wallet(AGENT_KEY);
    const first = await signHyperliquidL1ActionForTest(wallet, action, nonce, true);
    const second = await signHyperliquidL1ActionForTest(
      wallet,
      action,
      nonce + 1,
      true,
    );
    expect(first.r === second.r && first.s === second.s).toBe(false);
  });

  it("calcule un hash d'action stable et dépendant du nonce", () => {
    const first = hyperliquidActionHash(action, null, nonce);
    const second = hyperliquidActionHash(action, null, nonce);
    expect(first).toBe(second);
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hyperliquidActionHash(action, null, nonce + 1)).not.toBe(first);
  });

  it("échoue fermé en SIGN_FAILED avec une clé invalide", async () => {
    const result = await signHyperliquidOrder(
      { ...settings, agentPrivateKey: "0x1234" },
      INTENT,
      0,
      "perp-2026-08-28-0001",
      { now: () => nonce },
    );
    expect(result).toEqual({ ok: false, code: "SIGN_FAILED" });
  });
});

async function signHyperliquidL1ActionForTest(
  wallet: Wallet,
  action: unknown,
  nonce: number,
  isMainnet: boolean,
) {
  const factory = createEthersSignerFactory();
  const signer = factory(wallet.privateKey);
  return signer.signL1Action(action, nonce, isMainnet);
}

describe("soumission /exchange", () => {
  const makeSubmission = async () => {
    const result = await signHyperliquidOrder(
      settings,
      INTENT,
      0,
      "perp-2026-08-28-0001",
      { now: () => 1_756_416_000_000 },
    );
    if (!result.ok) throw new Error("signature expected");
    return result.value;
  };

  it("envoie exactement action, nonce et signature", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: "ok", response: { data: { statuses: [{ resting: { oid: 1 } }] } } }),
    );
    const submission = await makeSubmission();
    const issue = await submitHyperliquidOrder(settings, submission, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(issue).toEqual({ kind: "ACCEPTED" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${HYPERLIQUID_PRODUCTION_URL}/exchange`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["action", "nonce", "signature"]);
    expect(body.nonce).toBe(1_756_416_000_000);
    const signature = body.signature as Record<string, unknown>;
    expect(Object.keys(signature).sort()).toEqual(["r", "s", "v"]);
  });

  it("mappe une erreur d'ordre individuel en REJECTED", async () => {
    const submission = await makeSubmission();
    const issue = await submitHyperliquidOrder(settings, submission, {
      fetch: (async () =>
        jsonResponse({
          status: "ok",
          response: { data: { statuses: [{ error: "Insufficient margin" }] } },
        })) as unknown as typeof fetch,
    });
    expect(issue).toEqual({ kind: "REJECTED", detail: "Insufficient margin" });
  });

  it("mappe un corps status err en REJECTED", async () => {
    const submission = await makeSubmission();
    const issue = await submitHyperliquidOrder(settings, submission, {
      fetch: (async () =>
        jsonResponse({ status: "err", response: "Insufficient margin" })) as unknown as typeof fetch,
    });
    expect(issue).toEqual({ kind: "REJECTED", detail: "Insufficient margin" });
  });

  it("mappe réseau, HTTP 500, JSON et hors spec en UNKNOWN", async () => {
    const submission = await makeSubmission();
    const cases: ReadonlyArray<typeof fetch> = [
      (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      (async () => jsonResponse({ status: "err" }, 500)) as unknown as typeof fetch,
      (async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        })) as unknown as typeof fetch,
      (async () => jsonResponse({ hello: true })) as unknown as typeof fetch,
    ];
    for (const fetchMock of cases) {
      expect(
        await submitHyperliquidOrder(settings, submission, { fetch: fetchMock }),
      ).toEqual({ kind: "UNKNOWN" });
    }
  });
});

describe("réconciliation /info orderStatus", () => {
  it("résout un ordre exécuté ou posé en ACCEPTED", async () => {
    for (const status of ["filled", "resting", "open"]) {
      const issue = await reconcileHyperliquidOrder(settings, "perp-2026-08-28-0001", {
        fetch: (async () =>
          jsonResponse({
            status: "ok",
            data: { status: { status, order: {} } },
          })) as unknown as typeof fetch,
      });
      expect(issue).toEqual({ kind: "RESOLVED", outcome: "ACCEPTED" });
    }
  });

  it("résout un ordre jamais placé en REJECTED", async () => {
    const issue = await reconcileHyperliquidOrder(settings, "perp-2026-08-28-0001", {
      fetch: (async () =>
        jsonResponse({
          status: "ok",
          data: {
            status: {
              status:
                "Order was never placed, there is no order with cloid 0x…",
            },
          },
        })) as unknown as typeof fetch,
    });
    expect(issue).toEqual({ kind: "RESOLVED", outcome: "REJECTED" });
  });

  it("retourne UNKNOWN hors spec ou indisponible", async () => {
    const cases: ReadonlyArray<typeof fetch> = [
      (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      (async () => jsonResponse({ status: "err" })) as unknown as typeof fetch,
      (async () =>
        jsonResponse({ status: "ok", data: { status: { status: 42 } } })) as unknown as typeof fetch,
    ];
    for (const fetchMock of cases) {
      expect(
        await reconcileHyperliquidOrder(settings, "perp-2026-08-28-0001", {
          fetch: fetchMock,
        }),
      ).toEqual({ kind: "UNKNOWN" });
    }
  });

  it("interroge par cloid déterministe et adresse maître", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: "ok", data: { status: { status: "filled" } } }),
    );
    await reconcileHyperliquidOrder(settings, "perp-2026-08-28-0001", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${HYPERLIQUID_PRODUCTION_URL}/info`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.type).toBe("orderStatus");
    expect(body.user).toBe(WALLET_ADDRESS);
    expect(body.cloid).toBe(hyperliquidCloidFromClientOrderId("perp-2026-08-28-0001"));
  });
});

describe("méta /info", () => {
  it("retourne la méta validée ou null hors spec", async () => {
    const meta: HyperliquidMeta = {
      universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }],
    };
    expect(
      await fetchHyperliquidMeta(settings, {
        fetch: (async () => jsonResponse(meta)) as unknown as typeof fetch,
      }),
    ).toEqual(meta);
    expect(
      await fetchHyperliquidMeta(settings, {
        fetch: (async () => jsonResponse({})) as unknown as typeof fetch,
      }),
    ).toBeNull();
  });
});

describe("lectures de compte clearinghouseState", () => {
  const accountBody = {
    assetPositions: [
      {
        position: {
          coin: "BTC",
          szi: "0.010",
          unrealizedPnl: "12.5",
        },
      },
      {
        position: {
          coin: "DOGE",
          szi: "-10000",
          unrealizedPnl: "-3.0",
        },
      },
    ],
    marginSummary: {
      accountValue: "5000",
      totalRawUsd: "1200.5",
    },
  };

  it("convertit les chaînes décimales en instantané typé", async () => {
    const snapshot = await fetchHyperliquidAccountState(settings, {
      fetch: (async () => jsonResponse(accountBody)) as unknown as typeof fetch,
    });
    expect(snapshot).toEqual({
      accountValue: 5000,
      totalRawUsd: 1200.5,
      positions: [
        { coin: "BTC", quantity: 0.01, unrealizedPnl: 12.5 },
        { coin: "DOGE", quantity: -10000, unrealizedPnl: -3 },
      ],
    });
  });

  it("retourne null sur réseau indisponible ou réponse hors spec", async () => {
    const broken: ReadonlyArray<typeof fetch> = [
      (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
      (async () => jsonResponse({ assetPositions: "nope" })) as unknown as typeof fetch,
      (async () =>
        jsonResponse({
          assetPositions: [
            { position: { coin: "BTC", szi: "NaN", unrealizedPnl: "0" } },
          ],
          marginSummary: { accountValue: "1", totalRawUsd: "1" },
        })) as unknown as typeof fetch,
      (async () =>
        jsonResponse({ assetPositions: [] })) as unknown as typeof fetch,
    ];
    for (const fetchMock of broken) {
      expect(
        await fetchHyperliquidAccountState(settings, { fetch: fetchMock }),
      ).toBeNull();
    }
  });

  it("dérive la garde depuis la position réelle du marché visé", () => {
    const snapshot = {
      accountValue: 5000,
      totalRawUsd: 1200.5,
      positions: [{ coin: "BTC", quantity: 0.01, unrealizedPnl: 12.5 }],
    };
    const gate = derivePerpRiskGate({
      snapshot,
      coin: "BTC",
      markPrice: 100_000,
      dailyPnl: -40,
    });
    expect(gate).toEqual({
      admissionApproved: true,
      positionQuantity: 0.01,
      dailyPnl: -40,
      otherGrossExposureNotional: 200.5,
    });
  });

  it("met zéro sans position et borne l'exposition hors produit à zéro", () => {
    const withoutPosition = derivePerpRiskGate({
      snapshot: {
        accountValue: 500,
        totalRawUsd: 300,
        positions: [{ coin: "DOGE", quantity: -10000, unrealizedPnl: -3 }],
      },
      coin: "BTC",
      markPrice: 100_000,
      dailyPnl: 0,
    });
    expect(withoutPosition.positionQuantity).toBe(0);
    // Conservateur : DOGE hors allowlist compte dans l'exposition hors produit.
    expect(withoutPosition.otherGrossExposureNotional).toBe(300);

    const clamped = derivePerpRiskGate({
      snapshot: { accountValue: 10, totalRawUsd: 50, positions: [] },
      coin: "ETH",
      markPrice: 1,
      dailyPnl: 0,
    });
    expect(clamped.otherGrossExposureNotional).toBe(50);
  });
});

describe("lecture des fills /info userFills (dao #31)", () => {
  const CLOID = hyperliquidCloidFromClientOrderId("perp-2026-08-28-0001");

  const venueFill = (overrides: Record<string, unknown> = {}) => ({
    coin: "BTC",
    px: "100050.0",
    sz: "0.003",
    side: "B",
    time: 1_756_416_000_500,
    startPosition: 0,
    dir: "Open Long",
    closedPnl: "0.0",
    hash: "0xabc",
    oid: 308427057,
    crossed: true,
    fee: "0.15",
    tid: 441994346001,
    cloid: CLOID,
    ...overrides,
  });

  it("type fermé les fills de notre cloid uniquement", async () => {
    const fills = await fetchHyperliquidOrderFills(
      settings,
      "perp-2026-08-28-0001",
      {
        fetch: (async () =>
          jsonResponse([
            venueFill(),
            venueFill({
              cloid: `0x${"9".repeat(32)}`,
              tid: 441994346002,
              side: "A",
            }),
            venueFill({ cloid: undefined, tid: 441994346003 }),
          ])) as unknown as typeof fetch,
      },
    );
    expect(fills).toEqual([
      {
        fillId: "441994346001",
        side: "BUY",
        price: 100_050,
        quantity: 0.003,
        fee: 0.15,
        closedPnl: 0,
        fillTime: 1_756_416_000_500,
      },
    ]);
  });

  it("mappe side A sur SELL et closedPnl négatif tel quel", async () => {
    const fills = await fetchHyperliquidOrderFills(
      settings,
      "perp-2026-08-28-0001",
      {
        fetch: (async () =>
          jsonResponse([
            venueFill({ side: "A", closedPnl: "-12.5", px: "99000.0" }),
          ])) as unknown as typeof fetch,
      },
    );
    expect(fills).toEqual([
      {
        fillId: "441994346001",
        side: "SELL",
        price: 99_000,
        quantity: 0.003,
        fee: 0.15,
        closedPnl: -12.5,
        fillTime: 1_756_416_000_500,
      },
    ]);
  });

  it("retourne une liste vide sans fill de notre cloid", async () => {
    const fills = await fetchHyperliquidOrderFills(
      settings,
      "perp-2026-08-28-0001",
      {
        fetch: (async () => jsonResponse([])) as unknown as typeof fetch,
      },
    );
    expect(fills).toEqual([]);
  });

  it("rejette la lecture entière quand un fill de notre cloid est hors domaine", async () => {
    const cases: ReadonlyArray<Record<string, unknown>> = [
      venueFill({ px: "0" }),
      venueFill({ sz: "-0.001" }),
      venueFill({ fee: "-1" }),
      venueFill({ closedPnl: "x" }),
      venueFill({ tid: "abc" }),
      venueFill({ time: 1.5 }),
      venueFill({ side: "X" }),
    ];
    for (const entry of cases) {
      const fills = await fetchHyperliquidOrderFills(
        settings,
        "perp-2026-08-28-0001",
        {
          fetch: (async () =>
            jsonResponse([entry])) as unknown as typeof fetch,
        },
      );
      expect(fills).toBeNull();
    }
  });

  it("retourne null hors spec ou indisponible", async () => {
    const cases: ReadonlyArray<typeof fetch> = [
      (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      (async () =>
        jsonResponse({ status: "err" })) as unknown as typeof fetch,
      (async () => jsonResponse({ fills: [] })) as unknown as typeof fetch,
    ];
    for (const fetchMock of cases) {
      const fills = await fetchHyperliquidOrderFills(
        settings,
        "perp-2026-08-28-0001",
        { fetch: fetchMock },
      );
      expect(fills).toBeNull();
    }
  });
});
