import { err, ok, type Result } from "@dodash/domain";
import { z } from "zod";

import type { TradingTelemetryEvent } from "./telemetry.js";

/**
 * Seuils et politiques figés par models/operator-notifications.md.
 * Toute divergence avec le modèle est un défaut de revue.
 */
export const OPERATOR_NOTIFICATION_THRESHOLDS = {
  dailyPnlFloorUsd: -1_000,
  exposureCeilingUsd: 20_000,
  dedupeWindowMs: 60_000,
  timeoutMs: 5_000,
  maxAttempts: 2,
} as const;

export type OperatorNotificationClass =
  | "CYCLE_FAILED"
  | "ORDER_OUTCOME_UNKNOWN"
  | "DAILY_PNL_BREACH"
  | "EXPOSURE_BREACH"
  | "CONTROL_FAILED";

export type OperatorNotificationSourceKind = "cycle" | "control";

export interface OperatorNotificationSource {
  readonly kind: OperatorNotificationSourceKind;
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly dailyPnl: number | null;
  readonly otherExposureNotional: number | null;
}

export interface OperatorNotificationPayload {
  readonly schemaVersion: 1;
  readonly notificationId: string;
  readonly class: OperatorNotificationClass;
  readonly timestamp: number;
  readonly agentId: string;
  readonly productId: string;
  readonly executionMode: "paper" | "live" | "perp";
  readonly phase: string;
  readonly outcome: string;
  readonly errorCode: string | null;
}

export type OperatorNotificationSettingsInput = {
  readonly OPERATOR_NOTIFY_WEBHOOK_URL?: string;
  readonly OPERATOR_NOTIFY_SECRET?: string;
};

export interface OperatorNotificationSettings {
  readonly webhookUrl: string;
  readonly secret: string;
}

export type OperatorNotificationSettingsError =
  | { readonly code: "OPERATOR_NOTIFICATIONS_DISABLED" }
  | { readonly code: "OPERATOR_NOTIFICATIONS_INVALID" };

const settingsSchema = z.object({
  OPERATOR_NOTIFY_WEBHOOK_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://") || value.startsWith("http://")),
  OPERATOR_NOTIFY_SECRET: z.string().min(32),
});

export const resolveOperatorNotificationSettings = (
  input: OperatorNotificationSettingsInput,
): Result<
  OperatorNotificationSettings,
  OperatorNotificationSettingsError
> => {
  if (
    input.OPERATOR_NOTIFY_WEBHOOK_URL === undefined &&
    input.OPERATOR_NOTIFY_SECRET === undefined
  ) {
    return err({ code: "OPERATOR_NOTIFICATIONS_DISABLED" });
  }
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) {
    return err({ code: "OPERATOR_NOTIFICATIONS_INVALID" });
  }
  return ok({
    webhookUrl: parsed.data.OPERATOR_NOTIFY_WEBHOOK_URL,
    secret: parsed.data.OPERATOR_NOTIFY_SECRET,
  });
};

/**
 * Classification pure : chaque classe satisfaite produit exactement une
 * notification par enregistrement de télémétrie (avant déduplication).
 */
export const classifyOperatorNotifications = (
  source: OperatorNotificationSource,
): readonly OperatorNotificationClass[] => {
  const classes: OperatorNotificationClass[] = [];
  if (source.kind === "cycle") {
    if (source.outcome === "FAILED") classes.push("CYCLE_FAILED");
    if (source.errorCode === "ORDER_OUTCOME_UNKNOWN") {
      classes.push("ORDER_OUTCOME_UNKNOWN");
    }
    if (source.dailyPnl !== null && source.dailyPnl <= OPERATOR_NOTIFICATION_THRESHOLDS.dailyPnlFloorUsd) {
      classes.push("DAILY_PNL_BREACH");
    }
    if (
      source.otherExposureNotional !== null &&
      source.otherExposureNotional > OPERATOR_NOTIFICATION_THRESHOLDS.exposureCeilingUsd
    ) {
      classes.push("EXPOSURE_BREACH");
    }
  }
  if (source.kind === "control" && source.outcome === "FAILED") {
    classes.push("CONTROL_FAILED");
  }
  return classes;
};

/**
 * Déduplication : une classe identique (agent, classe) est supprimée pendant
 * la fenêtre figée après la dernière notification envoyée de cette classe.
 */
export interface OperatorNotificationDeduper {
  shouldSend(agentId: string, notificationClass: OperatorNotificationClass): boolean;
  markSent(agentId: string, notificationClass: OperatorNotificationClass): void;
}

export const createOperatorNotificationDeduper = (
  now: () => number = Date.now,
): OperatorNotificationDeduper => {
  const lastSentAt = new Map<string, number>();
  return {
    shouldSend(agentId, notificationClass) {
      const previous = lastSentAt.get(`${agentId}:${notificationClass}`);
      return (
        previous === undefined ||
        now() - previous >= OPERATOR_NOTIFICATION_THRESHOLDS.dedupeWindowMs
      );
    },
    markSent(agentId, notificationClass) {
      lastSentAt.set(`${agentId}:${notificationClass}`, now());
    },
  };
};

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256 hexadécimal du corps brut exactement envoyé. */
export const signOperatorNotificationPayload = async (
  secret: string,
  body: string,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return bytesToHex(new Uint8Array(signature));
};

type DeliveryOutcome = "DELIVERED" | "FAILED";

const deliverOnce = async (
  webhookUrl: string,
  body: string,
  signature: string,
  fetcher: typeof fetch,
): Promise<DeliveryOutcome> =>
  fetcher(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dodash-signature": signature,
    },
    body,
    signal: AbortSignal.timeout(OPERATOR_NOTIFICATION_THRESHOLDS.timeoutMs),
  }).then((response) => (response.ok ? "DELIVERED" : "FAILED"));

/**
 * Au plus une seconde tentative, uniquement sur échec réseau ou timeout,
 * jamais sur réponse HTTP 4xx/5xx.
 */
const deliverWithRetry = async (
  webhookUrl: string,
  body: string,
  signature: string,
  fetcher: typeof fetch,
): Promise<DeliveryOutcome> => {
  try {
    const first = await deliverOnce(webhookUrl, body, signature, fetcher);
    if (first === "DELIVERED") return "DELIVERED";
    return "FAILED";
  } catch {
    // Échec réseau ou timeout : seule condition de retry.
  }
  try {
    return await deliverOnce(webhookUrl, body, signature, fetcher);
  } catch {
    return "FAILED";
  }
};

export interface OperatorNotificationLogger {
  log(message: string): void;
  error(message: string): void;
}

export interface OperatorNotificationDeliveryDependencies {
  readonly fetch?: typeof fetch;
  readonly randomUUID?: () => string;
}

const toSource = (
  kind: OperatorNotificationSourceKind,
  event: TradingTelemetryEvent,
): OperatorNotificationSource => ({
  kind,
  outcome: event.outcome,
  errorCode: event.errorCode,
  dailyPnl: event.dailyPnl,
  otherExposureNotional: event.otherExposureNotional,
});

/**
 * Effet de bord de sortie, fire-and-forget : aucune exception ne remonte à
 * l'appelant, aucun échec réseau n'atteint la machine. La notification
 * s'ajoute à l'émission télémétrie, jamais à une décision.
 */
export const emitOperatorNotifications = (
  settings: OperatorNotificationSettings | undefined,
  kind: OperatorNotificationSourceKind,
  event: TradingTelemetryEvent,
  deduper: OperatorNotificationDeduper,
  logger: OperatorNotificationLogger = console,
  dependencies: OperatorNotificationDeliveryDependencies = {},
): void => {
  if (settings === undefined) return;
  const fetcher = dependencies.fetch ?? fetch;
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  for (const notificationClass of classifyOperatorNotifications(toSource(kind, event))) {
    if (!deduper.shouldSend(event.agentId, notificationClass)) continue;
    deduper.markSent(event.agentId, notificationClass);
    const payload: OperatorNotificationPayload = {
      schemaVersion: 1,
      notificationId: randomUUID(),
      class: notificationClass,
      timestamp: event.timestamp,
      agentId: event.agentId,
      productId: event.productId,
      executionMode: event.executionMode,
      phase: event.phase,
      outcome: event.outcome,
      errorCode: event.errorCode,
    };
    // Le corps est sérialisé une fois : la signature porte les octets exacts.
    const body = JSON.stringify(payload);
    void signOperatorNotificationPayload(settings.secret, body)
      .then((signature) =>
        deliverWithRetry(settings.webhookUrl, body, signature, fetcher),
      )
      .then((outcome) => {
        if (outcome === "FAILED") {
          logger.error(
            JSON.stringify({
              schemaVersion: 1,
              type: "operator-notification.delivery_failed",
              timestamp: event.timestamp,
              agentId: event.agentId,
              class: notificationClass,
            }),
          );
        }
      })
      .catch((error: unknown) => {
        logger.error(
          JSON.stringify({
            schemaVersion: 1,
            type: "operator-notification.delivery_failed",
            timestamp: event.timestamp,
            agentId: event.agentId,
            class: notificationClass,
            reason: error instanceof Error ? error.name : "UNKNOWN",
          }),
        );
      });
  }
};
