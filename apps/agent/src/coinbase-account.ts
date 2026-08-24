import type { PaperPortfolio } from "@dodash/backtest";
import { err, ok, type ProductId, type Result } from "@dodash/domain";
import type { WorkflowError } from "@dodash/models";
import { z } from "zod";

import { readBoundedJson } from "./bounded-json.js";
import {
  createCoinbaseAuthorization,
  type CoinbaseExecutionSettings,
  type CoinbaseJwtCredential,
  type CoinbaseRequestDependencies,
} from "./coinbase-execution.js";

const MAX_COINBASE_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 10_000;
const ACCOUNT_COMPONENT_TOLERANCE_USD = 0.01;

const moneySchema = z.object({
  value: z.string().min(1),
  currency: z.string().min(1),
});

const spotPositionSchema = z
  .object({
    asset: z.string().min(1),
    account_uuid: z.string().min(1),
    total_balance_fiat: z.number().finite().nonnegative(),
    total_balance_crypto: z.number().finite().nonnegative(),
    available_to_trade_fiat: z.number().finite().nonnegative(),
    available_to_trade_crypto: z.number().finite().nonnegative(),
    average_entry_price: moneySchema,
    is_cash: z.boolean(),
  })
  .passthrough();

const portfolioBreakdownSchema = z
  .object({
    breakdown: z.object({
      portfolio: z
        .object({
          uuid: z.string().min(1),
          deleted: z.boolean(),
        })
        .passthrough(),
      portfolio_balances: z
        .object({
          total_balance: moneySchema,
        })
        .passthrough(),
      spot_positions: z.array(spotPositionSchema),
    }),
  })
  .passthrough();

export interface CoinbaseAccountSnapshot {
  readonly snapshotId: string;
  readonly observedAt: number;
  readonly portfolioId: string;
  readonly portfolio: PaperPortfolio;
  readonly accountEquity: number;
  readonly targetExposureNotional: number;
  readonly otherExposureNotional: number;
  readonly availableBaseQuantity: number;
  readonly totalBaseQuantity: number;
}

export const coinbasePortfolioPath = (portfolioId: string): string => {
  if (portfolioId.trim().length === 0) {
    throw new Error("INVALID_COINBASE_PORTFOLIO_ID");
  }
  return `/api/v3/brokerage/portfolios/${encodeURIComponent(portfolioId)}`;
};

const reconciliationError = (
  code: WorkflowError["code"] = "RECONCILIATION_FAILURE",
  retryable = true,
): WorkflowError => ({ phase: "reconciliation", code, retryable });

const parseNonNegative = (value: string): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const credentialToken = (credential: unknown): string | null => {
  if (
    typeof credential !== "object" ||
    credential === null ||
    !("kind" in credential) ||
    credential.kind !== "coinbase-jwt" ||
    !("token" in credential) ||
    typeof credential.token !== "string" ||
    credential.token.length === 0
  ) {
    return null;
  }
  return (credential as CoinbaseJwtCredential).token;
};

const productCurrencies = (
  productId: ProductId,
): { readonly base: string; readonly quote: string } | null => {
  const separator = productId.lastIndexOf("-");
  if (separator <= 0 || separator === productId.length - 1) return null;
  return {
    base: productId.slice(0, separator),
    quote: productId.slice(separator + 1),
  };
};

export const reconcileCoinbaseAccount = async (
  settings: CoinbaseExecutionSettings,
  productId: ProductId,
  dependencies: CoinbaseRequestDependencies = {},
): Promise<Result<CoinbaseAccountSnapshot, WorkflowError>> => {
  const currencies = productCurrencies(productId);
  if (currencies === null || currencies.quote !== "USD") {
    return err(reconciliationError("INVALID_RESPONSE", false));
  }

  let path: string;
  try {
    path = coinbasePortfolioPath(settings.portfolioId);
  } catch {
    return err(reconciliationError("INVALID_RESPONSE", false));
  }
  const observedAt = dependencies.now?.() ?? Date.now();
  const authorization = createCoinbaseAuthorization(settings, "GET", path, {
    now: () => observedAt,
    ...(dependencies.nonce === undefined
      ? {}
      : { nonce: dependencies.nonce }),
  });
  if (!authorization.ok) return authorization;
  const token = credentialToken(authorization.value.credential);
  if (token === null) {
    return err(reconciliationError("AUTHENTICATION_FAILURE", false));
  }

  let response: Response;
  try {
    response = await (dependencies.fetch ?? fetch)(
      new URL(path, settings.apiBaseUrl).toString(),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch {
    return err(reconciliationError());
  }
  if (response.status === 429 || response.status >= 500) {
    return err(reconciliationError());
  }
  if (!response.ok) {
    return err(reconciliationError("INVALID_RESPONSE", false));
  }

  try {
    const parsed = portfolioBreakdownSchema.safeParse(
      await readBoundedJson(response, MAX_COINBASE_RESPONSE_BYTES),
    );
    if (!parsed.success) {
      return err(reconciliationError("INVALID_RESPONSE", false));
    }
    const { breakdown } = parsed.data;
    if (
      breakdown.portfolio.uuid !== settings.portfolioId ||
      breakdown.portfolio.deleted ||
      breakdown.portfolio_balances.total_balance.currency !== "USD"
    ) {
      return err(reconciliationError("INVALID_RESPONSE", false));
    }
    const accountEquity = parseNonNegative(
      breakdown.portfolio_balances.total_balance.value,
    );
    if (accountEquity === null) {
      return err(reconciliationError("INVALID_RESPONSE", false));
    }

    const basePositions = breakdown.spot_positions.filter(
      (position) => position.asset === currencies.base,
    );
    const quotePositions = breakdown.spot_positions.filter(
      (position) => position.asset === currencies.quote,
    );
    if (basePositions.length > 1 || quotePositions.length > 1) {
      return err(reconciliationError("INVALID_RESPONSE", false));
    }
    const base = basePositions[0];
    const quote = quotePositions[0];
    const totalBaseQuantity = base?.total_balance_crypto ?? 0;
    const availableBaseQuantity = base?.available_to_trade_crypto ?? 0;
    const targetExposureNotional = base?.total_balance_fiat ?? 0;
    const quoteTotal = quote?.total_balance_fiat ?? 0;
    const cash = quote?.available_to_trade_fiat ?? 0;
    const averagePriceSource = base?.average_entry_price;
    const averagePrice =
      totalBaseQuantity === 0
        ? 0
        : averagePriceSource?.currency === "USD"
          ? parseNonNegative(averagePriceSource.value)
          : null;
    if (
      averagePrice === null ||
      availableBaseQuantity > totalBaseQuantity + Number.EPSILON * 8
    ) {
      return err(reconciliationError("INVALID_RESPONSE", false));
    }
    const residual = accountEquity - quoteTotal - targetExposureNotional;
    if (residual < -ACCOUNT_COMPONENT_TOLERANCE_USD) {
      return err(reconciliationError("INVALID_RESPONSE", false));
    }
    const otherExposureNotional = Math.max(0, residual);
    return ok(
      Object.freeze({
        snapshotId: `coinbase:${settings.portfolioId}:${observedAt}`,
        observedAt,
        portfolioId: settings.portfolioId,
        portfolio: Object.freeze({
          cash,
          positionQuantity: totalBaseQuantity,
          averagePrice,
        }),
        accountEquity,
        targetExposureNotional,
        otherExposureNotional,
        availableBaseQuantity,
        totalBaseQuantity,
      }),
    );
  } catch {
    return err(reconciliationError("INVALID_RESPONSE", false));
  }
};
