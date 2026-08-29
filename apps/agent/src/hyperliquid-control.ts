import type {
  ControlPermissions,
  PerpRiskGate,
} from "@dodash/models";
import { z } from "zod";

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
