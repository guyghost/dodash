import {
  HYPERLIQUID_PERP_POLICY,
  type PerpOrderIntent,
  type PerpRiskGate,
} from "@dodash/models";
import { Wallet } from "ethers";

import { readBoundedJson } from "./bounded-json.js";
import {
  hyperliquidCloidFromClientOrderId,
  signHyperliquidL1Action,
  type HyperliquidOrderAction,
  type HyperliquidSignature,
} from "./hyperliquid-signing.js";
import type { HyperliquidExecutionSettings } from "./hyperliquid-settings.js";

/**
 * Effets REST et de construction d'ordre du shell Hyperliquid. Aucune
 * décision d'état : chaque fonction retourne une issue fermée qui se
 * traduit un-à-un en événement de `hyperliquidPerpOrderMachine`. Source de
 * vérité : models/hyperliquid-shell.md.
 */

export const HYPERLIQUID_EXCHANGE_PATH = "/exchange";
export const HYPERLIQUID_INFO_PATH = "/info";
export const MAX_HYPERLIQUID_RESPONSE_BYTES = 1_000_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const MARKET_ORDER_SLIPPAGE_BPS = 50;
const PRICE_SIGNIFICANT_FIGURES = 5;

const HYPERLIQUID_COINS = Object.freeze({
  "BTC-PERP": "BTC",
  "ETH-PERP": "ETH",
} satisfies Record<string, string>);

export type HyperliquidCoin = (typeof HYPERLIQUID_COINS)[keyof typeof HYPERLIQUID_COINS];

export const hyperliquidCoin = (productId: string): HyperliquidCoin | null => {
  const coin = (HYPERLIQUID_COINS as Record<string, string>)[productId];
  return typeof coin === "string" ? (coin as HyperliquidCoin) : null;
};

export interface HyperliquidRequestDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly signer?: SignerFactory;
}

export type SignerFactory = (privateKey: string) => OrderSigner;

export interface OrderSigner {
  readonly address: string;
  signL1Action(action: unknown, nonce: number, isMainnet: boolean): Promise<HyperliquidSignature>;
}

export const createEthersSignerFactory = (): SignerFactory => (privateKey) => {
  const wallet = new Wallet(privateKey);
  return {
    address: wallet.address,
    signL1Action: (action, nonce, isMainnet) =>
      signHyperliquidL1Action(wallet, action, nonce, isMainnet),
  };
};

export type HyperliquidSubmitIssue =
  | { readonly kind: "ACCEPTED" }
  | { readonly kind: "REJECTED"; readonly detail: string }
  | { readonly kind: "UNKNOWN" };

export type HyperliquidReconciliationIssue =
  | { readonly kind: "RESOLVED"; readonly outcome: "ACCEPTED" | "REJECTED" }
  | { readonly kind: "UNKNOWN" };

export interface HyperliquidMeta {
  readonly universe: ReadonlyArray<{
    readonly name: string;
    readonly szDecimals: number;
    readonly maxLeverage: number;
  }>;
}

const removeTrailingZeros = (value: string): string => {
  if (!value.includes(".")) return value;
  const normalized = value.replace(/\.?0+$/, "");
  return normalized === "-0" ? "0" : normalized;
};

/** Prix d'agression : marque ± cap de glissement, borné à 5 chiffres significatifs. */
export const aggressivePrice = (markPrice: number, side: "BUY" | "SELL"): string => {
  const slip = 1 + (side === "BUY" ? 1 : -1) * (MARKET_ORDER_SLIPPAGE_BPS / 10_000);
  const priced = Number((markPrice * slip).toPrecision(PRICE_SIGNIFICANT_FIGURES));
  return removeTrailingZeros(priced.toFixed(8));
};

const wireSize = (productId: string, quantity: number): string => {
  const decimals =
    HYPERLIQUID_PERP_POLICY.sizeDecimals[
      productId as keyof typeof HYPERLIQUID_PERP_POLICY.sizeDecimals
    ];
  if (typeof decimals !== "number") return removeTrailingZeros(quantity.toFixed(8));
  return removeTrailingZeros(quantity.toFixed(decimals));
};

export const hyperliquidMarketIocOrder = (
  intent: PerpOrderIntent,
  assetIndex: number,
  clientOrderId: string,
): HyperliquidOrderAction => {
  const wire = {
    a: assetIndex,
    b: intent.side === "BUY",
    p: aggressivePrice(intent.markPrice, intent.side),
    s: wireSize(intent.productId, intent.quantity),
    r: false,
    t: { limit: { tif: "Ioc" as const } },
    c: hyperliquidCloidFromClientOrderId(clientOrderId),
  };
  return Object.freeze({
    type: "order" as const,
    orders: Object.freeze([Object.freeze(wire)]),
    grouping: "na" as const,
  });
};

export const assetIndexForCoin = (
  meta: HyperliquidMeta,
  coin: HyperliquidCoin,
): number | null => {
  if (!Array.isArray(meta.universe)) return null;
  const index = meta.universe.findIndex((asset) => asset?.name === coin);
  return index >= 0 ? index : null;
};

const boundedRequest = async (
  dependencies: HyperliquidRequestDependencies,
  settings: HyperliquidExecutionSettings,
  path: string,
  body: unknown,
): Promise<unknown | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (dependencies.fetch ?? fetch)(
      `${settings.apiBaseUrl}${path}`,
      {
        method: "POST",
        headers: Object.freeze({ "content-type": "application/json" }),
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    return await readBoundedJson(response, MAX_HYPERLIQUID_RESPONSE_BYTES);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export interface HyperliquidSubmission {
  readonly action: HyperliquidOrderAction;
  readonly nonce: number;
  readonly signature: HyperliquidSignature;
}

/** Signe l'action ordre : seul effet où la clé d'agent est utilisée. */
export const signHyperliquidOrder = async (
  settings: HyperliquidExecutionSettings,
  intent: PerpOrderIntent,
  assetIndex: number,
  clientOrderId: string,
  dependencies: HyperliquidRequestDependencies = {},
): Promise<{ readonly ok: true; readonly value: HyperliquidSubmission } | { readonly ok: false; readonly code: "SIGN_FAILED" | "HYPERLIQUID_MARKET_UNKNOWN" }> => {
  try {
    const action = hyperliquidMarketIocOrder(intent, assetIndex, clientOrderId);
    const signer = (dependencies.signer ?? createEthersSignerFactory())(
      settings.agentPrivateKey,
    );
    const nonce = dependencies.now?.() ?? Date.now();
    const signature = await signer.signL1Action(
      action,
      nonce,
      !settings.isTestnet,
    );
    return {
      ok: true,
      value: Object.freeze({ action, nonce, signature }),
    };
  } catch {
    return { ok: false, code: "SIGN_FAILED" };
  }
};

interface OrderStatusShape {
  readonly status?: unknown;
  readonly response?: unknown;
}

const orderErrorDetail = (statuses: unknown): string | null => {
  if (!Array.isArray(statuses)) return null;
  const first = statuses[0] as { error?: unknown } | undefined;
  return typeof first?.error === "string" ? first.error : null;
};

export const submitHyperliquidOrder = async (
  settings: HyperliquidExecutionSettings,
  submission: HyperliquidSubmission,
  dependencies: HyperliquidRequestDependencies = {},
): Promise<HyperliquidSubmitIssue> => {
  const parsed = (await boundedRequest(dependencies, settings, HYPERLIQUID_EXCHANGE_PATH, {
    action: submission.action,
    nonce: submission.nonce,
    signature: submission.signature,
  })) as OrderStatusShape | null;
  if (parsed === null || typeof parsed !== "object") return Object.freeze({ kind: "UNKNOWN" });
  if (parsed.status === "err") {
    return Object.freeze({
      kind: "REJECTED",
      detail:
        typeof parsed.response === "string" ? parsed.response : "HYPERLIQUID_ERROR",
    });
  }
  if (parsed.status !== "ok") return Object.freeze({ kind: "UNKNOWN" });
  const error = orderErrorDetail(
    (parsed.response as { data?: { statuses?: unknown } } | null)?.data?.statuses,
  );
  if (error !== null) return Object.freeze({ kind: "REJECTED", detail: error });
  return Object.freeze({ kind: "ACCEPTED" });
};

interface OrderStatusResponse {
  readonly status?: unknown;
  readonly data?: { readonly status?: { readonly status?: unknown } };
}

export const reconcileHyperliquidOrder = async (
  settings: HyperliquidExecutionSettings,
  clientOrderId: string,
  dependencies: HyperliquidRequestDependencies = {},
): Promise<HyperliquidReconciliationIssue> => {
  const parsed = (await boundedRequest(dependencies, settings, HYPERLIQUID_INFO_PATH, {
    type: "orderStatus",
    user: settings.walletAddress,
    cloid: hyperliquidCloidFromClientOrderId(clientOrderId),
  })) as OrderStatusResponse | null;
  if (parsed === null || typeof parsed !== "object" || parsed.status !== "ok") {
    return Object.freeze({ kind: "UNKNOWN" });
  }
  const state = parsed.data?.status;
  if (typeof state !== "object" || state === null) {
    return Object.freeze({ kind: "UNKNOWN" });
  }
  const status = (state as { status?: unknown }).status;
  if (typeof status !== "string") return Object.freeze({ kind: "UNKNOWN" });
  if (status === "filled" || status === "resting" || status === "open") {
    return Object.freeze({ kind: "RESOLVED", outcome: "ACCEPTED" });
  }
  if (status === "canceled" || status === "marginCanceled") {
    return Object.freeze({ kind: "RESOLVED", outcome: "ACCEPTED" });
  }
  if (status.startsWith("Order was never placed")) {
    return Object.freeze({ kind: "RESOLVED", outcome: "REJECTED" });
  }
  if (status.includes("never placed") || status.includes("rejected")) {
    return Object.freeze({ kind: "RESOLVED", outcome: "REJECTED" });
  }
  return Object.freeze({ kind: "UNKNOWN" });
};

export const fetchHyperliquidMeta = async (
  settings: HyperliquidExecutionSettings,
  dependencies: HyperliquidRequestDependencies = {},
): Promise<HyperliquidMeta | null> => {
  const parsed = (await boundedRequest(dependencies, settings, HYPERLIQUID_INFO_PATH, {
    type: "meta",
  })) as HyperliquidMeta | null;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as HyperliquidMeta).universe)
  ) {
    return null;
  }
  return Object.freeze(parsed);
};

export interface HyperliquidAccountPosition {
  readonly coin: string;
  readonly quantity: number;
  readonly unrealizedPnl: number;
}

export interface HyperliquidAccountSnapshot {
  readonly accountValue: number;
  readonly totalRawUsd: number;
  readonly positions: readonly HyperliquidAccountPosition[];
}

const finiteFrom = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Lecture du compte clearinghouseState : instantané typé fermé, ou null
 * si la réponse est indisponible ou hors spec — jamais de zéros
 * substitués. Source de vérité : models/hyperliquid-shell.md.
 */
export const fetchHyperliquidAccountState = async (
  settings: HyperliquidExecutionSettings,
  dependencies: HyperliquidRequestDependencies = {},
): Promise<HyperliquidAccountSnapshot | null> => {
  const parsed = (await boundedRequest(dependencies, settings, HYPERLIQUID_INFO_PATH, {
    type: "clearinghouseState",
    user: settings.walletAddress,
  })) as {
    assetPositions?: unknown;
    marginSummary?: {
      accountValue?: unknown;
      totalRawUsd?: unknown;
    };
  } | null;
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.assetPositions)) {
    return null;
  }
  const accountValue = finiteFrom(parsed.marginSummary?.accountValue);
  const totalRawUsd = finiteFrom(parsed.marginSummary?.totalRawUsd);
  if (accountValue === null || totalRawUsd === null) return null;
  const positions: HyperliquidAccountPosition[] = [];
  for (const entry of parsed.assetPositions) {
    const position = (entry as { position?: unknown } | null)?.position as
      | { coin?: unknown; szi?: unknown; unrealizedPnl?: unknown }
      | undefined;
    const coin = position?.coin;
    const quantity = finiteFrom(position?.szi);
    const unrealizedPnl = finiteFrom(position?.unrealizedPnl) ?? 0;
    if (typeof coin !== "string" || quantity === null) return null;
    positions.push({ coin, quantity, unrealizedPnl });
  }
  return Object.freeze({
    accountValue,
    totalRawUsd,
    positions: Object.freeze(positions),
  });
};

/**
 * Dérivation des entrées de garde depuis le compte réel : position du
 * marché visé depuis szi, exposition hors produit = totalRawUsd − own
 * notional (bornée à zéro, conservatrice), PnL journalier jamais inféré.
 */
export const derivePerpRiskGate = ({
  snapshot,
  coin,
  markPrice,
  dailyPnl,
}: {
  readonly snapshot: HyperliquidAccountSnapshot;
  readonly coin: HyperliquidCoin;
  readonly markPrice: number;
  readonly dailyPnl: number;
}): PerpRiskGate => {
  const own = snapshot.positions.find((position) => position.coin === coin);
  const positionQuantity = own?.quantity ?? 0;
  const ownNotional = Math.abs(positionQuantity) * markPrice;
  const otherGross = Math.max(0, snapshot.totalRawUsd - ownNotional);
  return Object.freeze({
    admissionApproved: true,
    positionQuantity,
    dailyPnl,
    otherGrossExposureNotional: otherGross,
  });
};
