import { HYPERLIQUID_PERP_POLICY, type HyperliquidPerpProduct } from "@dodash/models";

import { hyperliquidCoin, type HyperliquidMeta } from "./hyperliquid-execution.js";

/**
 * Préflight live perp : la méta réelle du marché doit confirmer l'enveloppe
 * figée avant toute activation. Source de vérité :
 * models/hyperliquid-shell.md et models/hyperliquid-execution.md.
 */

export type HyperliquidPreflightFindingCode =
  | "HYPERLIQUID_MARKET_MISSING"
  | "HYPERLIQUID_SIZE_DECIMALS_MISMATCH"
  | "HYPERLIQUID_LEVERAGE_CAP_UNAVAILABLE";

export interface HyperliquidPreflightFinding {
  readonly productId: HyperliquidPerpProduct;
  readonly code: HyperliquidPreflightFindingCode;
  readonly expected: number | string;
  readonly actual: number | string | null;
}

export type HyperliquidPreflightResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly findings: readonly HyperliquidPreflightFinding[] };

export const runHyperliquidPreflight = (
  meta: HyperliquidMeta | null,
): HyperliquidPreflightResult => {
  if (meta === null || !Array.isArray(meta.universe)) {
    return Object.freeze({
      ok: false,
      findings: Object.freeze([
        Object.freeze({
          productId: HYPERLIQUID_PERP_POLICY.products[0],
          code: "HYPERLIQUID_MARKET_MISSING" as const,
          expected: hyperliquidCoin(HYPERLIQUID_PERP_POLICY.products[0]) ?? "",
          actual: null,
        }),
      ]),
    });
  }
  const findings: HyperliquidPreflightFinding[] = [];
  for (const productId of HYPERLIQUID_PERP_POLICY.products) {
    const coin = hyperliquidCoin(productId);
    const asset =
      coin === null
        ? undefined
        : meta.universe.find((entry) => entry?.name === coin);
    if (typeof asset?.szDecimals !== "number" || typeof asset?.maxLeverage !== "number") {
      findings.push(
        Object.freeze({
          productId,
          code: "HYPERLIQUID_MARKET_MISSING" as const,
          expected: coin ?? productId,
          actual: null,
        }),
      );
      continue;
    }
    if (asset.szDecimals !== HYPERLIQUID_PERP_POLICY.sizeDecimals[productId]) {
      findings.push(
        Object.freeze({
          productId,
          code: "HYPERLIQUID_SIZE_DECIMALS_MISMATCH" as const,
          expected: HYPERLIQUID_PERP_POLICY.sizeDecimals[productId],
          actual: asset.szDecimals,
        }),
      );
      continue;
    }
    if (asset.maxLeverage < HYPERLIQUID_PERP_POLICY.maxLeverage) {
      findings.push(
        Object.freeze({
          productId,
          code: "HYPERLIQUID_LEVERAGE_CAP_UNAVAILABLE" as const,
          expected: HYPERLIQUID_PERP_POLICY.maxLeverage,
          actual: asset.maxLeverage,
        }),
      );
    }
  }
  return findings.length === 0
    ? Object.freeze({ ok: true })
    : Object.freeze({ ok: false, findings: Object.freeze(findings) });
};
