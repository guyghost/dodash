import {
  HYPERLIQUID_PERP_POLICY,
  type ControlPermissions,
  type PerpOrderIntent,
  type PerpRiskGate,
} from "@dodash/models";
import { z } from "zod";

/**
 * Mapping signal spot Coinbase → perp Hyperliquid (option proxy,
 * models/hyperliquid-signals.md).
 */
export const HYPERLIQUID_SIGNAL_MAP = Object.freeze({
  "BTC-USD": "BTC-PERP",
  "ETH-USD": "ETH-PERP",
} as const);

export const perpProductForSignal = (
  signalProductId: string,
): "BTC-PERP" | "ETH-PERP" | null => {
  const mapped = (HYPERLIQUID_SIGNAL_MAP as Record<string, string>)[signalProductId];
  return mapped === "BTC-PERP" || mapped === "ETH-PERP" ? mapped : null;
};

/**
 * Conversion pure d'une décision du cœur en intention perp : mapping
 * produit, quantité arrondie vers zéro à szDecimals, levier effectif 1
 * (la borne 2x de l'enveloppe est un plafond, pas un objectif).
 */
export const toPerpIntent = ({
  intent,
  markPrice,
}: {
  readonly intent: {
    readonly productId: string;
    readonly side: "BUY" | "SELL";
    readonly quantity: number;
  };
  readonly markPrice: number;
}): PerpOrderIntent | null => {
  const productId = perpProductForSignal(intent.productId);
  if (productId === null) return null;
  const decimals =
    HYPERLIQUID_PERP_POLICY.sizeDecimals[
      productId as keyof typeof HYPERLIQUID_PERP_POLICY.sizeDecimals
    ];
  if (
    typeof decimals !== "number" ||
    !Number.isFinite(intent.quantity) ||
    intent.quantity <= 0
  ) {
    return null;
  }
  const factor = 10 ** decimals;
  const quantity = Math.floor(intent.quantity * factor + 1e-9) / factor;
  if (quantity <= 0) return null;
  return Object.freeze({
    productId,
    side: intent.side,
    quantity,
    markPrice,
    leverage: 1,
  });
};

import type { HyperliquidRequestDependencies } from "./hyperliquid-execution.js";
import {
  derivePerpRiskGate,
  fetchHyperliquidAccountState,
  hyperliquidCoin,
} from "./hyperliquid-execution.js";
import type {
  HyperliquidPerpRunResult,
  PerpOrderStore,
} from "./hyperliquid-orchestrator.js";
import {
  createHyperliquidPerpRunner,
  type HyperliquidRecoveryReport,
} from "./hyperliquid-orchestrator.js";
import type { HyperliquidSettingsInput } from "./hyperliquid-settings.js";
import { resolveHyperliquidSettings } from "./hyperliquid-settings.js";
import {
  createSqlitePerpOrderStore,
  type PerpOrderSqlAdapter,
} from "./hyperliquid-store.js";

/**
 * Contrôle opérateur pour l'exécution perp : validation bornée du corps,
 * permissions, réglages et runner. Aucune décision métier ici — la machine
 * et ses gardes arbitrent. Source de vérité :
 * models/hyperliquid-orchestration.md (câblage runtime).
 */

export const perpOrderRequestSchema = z.object({
  intent: z.object({
    productId: z.string().min(1).max(40),
    side: z.enum(["BUY", "SELL"]),
    quantity: z.number().positive().finite(),
    markPrice: z.number().positive().finite(),
    leverage: z.number().int().min(1).max(10),
  }),
  gate: z.object({
    // Champs dérivables du compte réel : s'ils sont omis, la route les
    // lit sur clearinghouseState. dailyPnl n'est jamais inféré.
    positionQuantity: z.number().finite().optional(),
    dailyPnl: z.number().finite(),
    otherGrossExposureNotional: z.number().finite().min(0).optional(),
  }),
  clientOrderId: z
    .string()
    .regex(/^[a-zA-Z0-9-]{8,64}$/),
});

export type PerpOrderRequestBody = z.infer<typeof perpOrderRequestSchema>;

export type PerpOrderRequestResult =
  | { readonly ok: true; readonly result: HyperliquidPerpRunResult }
  | {
      readonly ok: false;
      readonly code:
        | "CONTROL_PERMISSION_REQUIRED"
        | "HYPERLIQUID_EXECUTION_UNAVAILABLE"
        | "INVALID_PERP_ORDER_REQUEST"
        | "PERP_ACCOUNT_UNAVAILABLE";
    };

export const submitPerpOrderIntent = async ({
  input,
  permissions,
  settingsInput,
  sql,
  now,
  fetch: fetchFn,
}: {
  readonly input: unknown;
  readonly permissions: ControlPermissions;
  readonly settingsInput: HyperliquidSettingsInput;
  readonly sql: PerpOrderSqlAdapter;
  readonly now: () => number;
  readonly fetch?: typeof fetch;
}): Promise<PerpOrderRequestResult> => {
  if (!permissions.canControl || !permissions.canTrade) {
    return { ok: false, code: "CONTROL_PERMISSION_REQUIRED" };
  }
  const settings = resolveHyperliquidSettings(settingsInput);
  if (!settings.ok) {
    return { ok: false, code: "HYPERLIQUID_EXECUTION_UNAVAILABLE" };
  }
  const parsed = perpOrderRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PERP_ORDER_REQUEST" };
  }
  const store: PerpOrderStore = createSqlitePerpOrderStore(sql);
  const runner = createHyperliquidPerpRunner({
    settings: settings.value,
    store,
    dependencies: {
      now,
      ...(fetchFn === undefined ? {} : { fetch: fetchFn }),
    } satisfies HyperliquidRequestDependencies,
  });
  const { gate, ...order } = parsed.data;
  const coin = hyperliquidCoin(order.intent.productId);
  const needsAccountRead =
    gate.positionQuantity === undefined ||
    gate.otherGrossExposureNotional === undefined;
  let riskGate: PerpRiskGate;
  if (needsAccountRead) {
    if (coin === null) {
      return { ok: false, code: "INVALID_PERP_ORDER_REQUEST" };
    }
    const snapshot = await fetchHyperliquidAccountState(settings.value, {
      now,
      ...(fetchFn === undefined ? {} : { fetch: fetchFn }),
    });
    if (snapshot === null) {
      return { ok: false, code: "PERP_ACCOUNT_UNAVAILABLE" };
    }
    riskGate = derivePerpRiskGate({
      snapshot,
      coin,
      markPrice: order.intent.markPrice,
      dailyPnl: gate.dailyPnl,
    });
  } else {
    riskGate = {
      admissionApproved: true,
      positionQuantity: gate.positionQuantity as number,
      dailyPnl: gate.dailyPnl,
      otherGrossExposureNotional: gate.otherGrossExposureNotional as number,
    };
  }
  const result = await runner.runOrder({
    // admissionApproved est dérivé par le runner lui-même avant l'événement :
    // l'opérateur ne peut pas le revendiquer.
    intent: order.intent,
    gate: riskGate,
    clientOrderId: order.clientOrderId,
  });
  return { ok: true, result };
};

export interface PerpRecoveryOutcome extends HyperliquidRecoveryReport {
  readonly unavailable: boolean;
}

export const recoverPerpOrders = async ({
  settingsInput,
  sql,
  now,
  fetch: fetchFn,
}: {
  readonly settingsInput: HyperliquidSettingsInput;
  readonly sql: PerpOrderSqlAdapter;
  readonly now: () => number;
  readonly fetch?: typeof fetch;
}): Promise<PerpRecoveryOutcome> => {
  const settings = resolveHyperliquidSettings(settingsInput);
  if (!settings.ok) {
    return { recovered: 0, unresolved: 0, unavailable: true };
  }
  const store: PerpOrderStore = createSqlitePerpOrderStore(sql);
  const runner = createHyperliquidPerpRunner({
    settings: settings.value,
    store,
    dependencies: {
      now,
      ...(fetchFn === undefined ? {} : { fetch: fetchFn }),
    } satisfies HyperliquidRequestDependencies,
  });
  const report = await runner.recoverPending();
  return { ...report, unavailable: false };
};
