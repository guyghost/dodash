import { BASE_URLS, signL1Action as sdkSignL1Action } from "hyperliquid";
import { Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";

import {
  aggressivePrice,
  assetIndexForCoin,
  createEthersSignerFactory,
  fetchHyperliquidMeta,
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
