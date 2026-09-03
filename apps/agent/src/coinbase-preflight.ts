import { createProductId } from "@dodash/domain";
import {
  assessLivePreflight,
  LIVE_TRADING_PRODUCTS,
  type LivePreflightAssessment,
  type LivePreflightEvidence,
} from "@dodash/models";
import { z } from "zod";

import { readBoundedJson } from "./bounded-json.js";
import { reconcileCoinbaseAccount } from "./coinbase-account.js";
import { listCoinbaseOpenProductOrderIds } from "./coinbase-control.js";
import { resolveOperatorNotificationSettings } from "./operator-notifications.js";
import {
  createCoinbaseAuthorization,
  resolveCoinbasePreflightSettings,
  verifyCoinbaseProductTradingRules,
  type CoinbaseJwtCredential,
  type CoinbaseRequestDependencies,
  type CoinbaseSettingsInput,
} from "./coinbase-execution.js";

const COINBASE_KEY_PERMISSIONS_PATH = "/api/v3/brokerage/key_permissions";
const MAX_COINBASE_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 10_000;

const keyPermissionsSchema = z.object({
  can_view: z.boolean(),
  can_trade: z.boolean(),
  can_transfer: z.boolean(),
  portfolio_uuid: z.string().min(1),
});

export interface CoinbaseLivePreflightReport {
  readonly productId: string;
  readonly assessment: LivePreflightAssessment;
  readonly evidence: LivePreflightEvidence;
  readonly observedAt: number;
  readonly openOrderCount: number | null;
}

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

export const preflightCoinbaseLive = async (
  input: CoinbaseSettingsInput,
  productIdSource: string,
  knownProtectiveOrderIds: readonly string[],
  dependencies: CoinbaseRequestDependencies = {},
): Promise<CoinbaseLivePreflightReport> => {
  const observedAt = dependencies.now?.() ?? Date.now();
  const evidence: {
    -readonly [Key in keyof LivePreflightEvidence]: LivePreflightEvidence[Key];
  } = {
    liveTradingDisabled: input.LIVE_TRADING_ENABLED !== "true",
    credentialsConfigured: false,
    telemetryConfigured: input.TRADING_TELEMETRY !== undefined,
    operatorNotificationsConfigured:
      resolveOperatorNotificationSettings(input).ok,
    keyCanView: false,
    keyCanTrade: false,
    keyCanTransfer: false,
    keyPortfolioMatches: false,
    productAllowed: false,
    accountReconciled: false,
    allOpenOrdersOwned: false,
    productRulesValid: false,
  };
  let openOrderCount: number | null = null;
  const report = (): CoinbaseLivePreflightReport => {
    const frozenEvidence = Object.freeze({ ...evidence });
    return Object.freeze({
      productId: productIdSource,
      assessment: assessLivePreflight(frozenEvidence),
      evidence: frozenEvidence,
      observedAt,
      openOrderCount,
    });
  };
  if (!evidence.liveTradingDisabled) return report();

  const settings = resolveCoinbasePreflightSettings(input);
  if (!settings.ok) return report();
  evidence.credentialsConfigured = true;

  const product = createProductId(productIdSource);
  if (!product.ok) return report();
  evidence.productAllowed = LIVE_TRADING_PRODUCTS.includes(
    product.value as (typeof LIVE_TRADING_PRODUCTS)[number],
  );

  const authorization = createCoinbaseAuthorization(
    settings.value,
    "GET",
    COINBASE_KEY_PERMISSIONS_PATH,
    {
      now: () => observedAt,
      ...(dependencies.nonce === undefined
        ? {}
        : { nonce: dependencies.nonce }),
    },
  );
  if (!authorization.ok) return report();
  const token = credentialToken(authorization.value.credential);
  if (token === null) return report();
  try {
    const response = await (dependencies.fetch ?? fetch)(
      new URL(COINBASE_KEY_PERMISSIONS_PATH, settings.value.apiBaseUrl).toString(),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) return report();
    const parsed = keyPermissionsSchema.safeParse(
      await readBoundedJson(response, MAX_COINBASE_RESPONSE_BYTES),
    );
    if (!parsed.success) return report();
    evidence.keyCanView = parsed.data.can_view;
    evidence.keyCanTrade = parsed.data.can_trade;
    evidence.keyCanTransfer = parsed.data.can_transfer;
    evidence.keyPortfolioMatches =
      parsed.data.portfolio_uuid === settings.value.portfolioId;
  } catch {
    return report();
  }

  const account = await reconcileCoinbaseAccount(
    settings.value,
    product.value,
    dependencies,
  );
  evidence.accountReconciled = account.ok;

  const openOrders = await listCoinbaseOpenProductOrderIds(
    settings.value,
    product.value,
    dependencies,
  );
  if (openOrders.ok) {
    openOrderCount = openOrders.value.length;
    const known = new Set(knownProtectiveOrderIds);
    evidence.allOpenOrdersOwned = openOrders.value.every((orderId) =>
      known.has(orderId),
    );
  }

  const productRules = await verifyCoinbaseProductTradingRules(
    settings.value,
    product.value,
    dependencies,
  );
  evidence.productRulesValid = productRules.ok;
  return report();
};
