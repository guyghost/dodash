import {
  admitHyperliquidPerpConfiguration,
  hyperliquidPerpOrderMachine,
  HYPERLIQUID_PERP_POLICY,
  type HyperliquidOrderOutcome,
  type HyperliquidPerpCandidate,
  type PerpExecutionError,
  type PerpOrderIntent,
  type PerpRefusalCode,
  type PerpRiskGate,
} from "@dodash/models";
import { createActor } from "xstate";

import {
  assetIndexForCoin,
  fetchHyperliquidMeta,
  hyperliquidCoin,
  type HyperliquidRequestDependencies,
  type HyperliquidSubmission,
  reconcileHyperliquidOrder,
  signHyperliquidOrder,
  submitHyperliquidOrder,
} from "./hyperliquid-execution.js";
import { createEthersSignerFactory, type OrderSigner } from "./hyperliquid-execution.js";
import type { HyperliquidExecutionSettings } from "./hyperliquid-settings.js";

/**
 * Runner perp : pilote `hyperliquidPerpOrderMachine` avec les effets du
 * shell et un port de persistance. Aucune décision métier — chaque issue
 * du shell devient au plus un événement de machine ; la signature est
 * produite une seule fois et le payload signé soumis au plus une fois ;
 * la reprise après crash n'entre que par la réconciliation. Source de
 * vérité : models/hyperliquid-orchestration.md.
 */

export interface PerpOrderRecord {
  readonly clientOrderId: string;
  readonly intent: PerpOrderIntent;
  readonly createdAt: number;
}

export interface PerpOrderStore {
  persistOrderIntent(record: PerpOrderRecord): Promise<void>;
  persistOutcome(
    clientOrderId: string,
    outcome: HyperliquidOrderOutcome,
    settledAt: number,
  ): Promise<void>;
  loadUnresolvedOrderIntents(): Promise<readonly PerpOrderRecord[]>;
}

export const createInMemoryPerpOrderStore = (): PerpOrderStore => {
  const intents = new Map<string, PerpOrderRecord>();
  const outcomes = new Map<string, HyperliquidOrderOutcome>();
  return {
    async persistOrderIntent(record) {
      intents.set(record.clientOrderId, record);
    },
    async persistOutcome(clientOrderId, outcome) {
      outcomes.set(clientOrderId, outcome);
    },
    async loadUnresolvedOrderIntents() {
      return [...intents.values()]
        .filter((record) => !outcomes.has(record.clientOrderId))
        .reverse();
    },
  };
};

export type HyperliquidPerpRunResult =
  | {
      readonly status: "SETTLED";
      readonly outcome: HyperliquidOrderOutcome;
      readonly clientOrderId: string;
    }
  | { readonly status: "REFUSED"; readonly reasonCode: PerpRefusalCode }
  | { readonly status: "FAILED"; readonly error: PerpExecutionError };

export interface HyperliquidRecoveryReport {
  readonly recovered: number;
  readonly unresolved: number;
}

export interface HyperliquidPerpRunner {
  runOrder(request: {
    readonly intent: PerpOrderIntent;
    readonly gate: PerpRiskGate;
    readonly clientOrderId: string;
  }): Promise<HyperliquidPerpRunResult>;
  recoverPending(): Promise<HyperliquidRecoveryReport>;
}

const candidateFor = (productId: string): HyperliquidPerpCandidate =>
  Object.freeze({
    executionMode: "live",
    venue: HYPERLIQUID_PERP_POLICY.venue,
    productId,
    timeframe: HYPERLIQUID_PERP_POLICY.timeframe,
    maxLeverage: HYPERLIQUID_PERP_POLICY.maxLeverage,
    risk: { ...HYPERLIQUID_PERP_POLICY.risk },
  });

const createOrderMachine = () =>
  createActor(hyperliquidPerpOrderMachine, { input: {} }).start();

type OrderMachine = ReturnType<typeof createOrderMachine>;

const failureOf = (snapshot: {
  readonly context: { readonly lastError: PerpExecutionError | null };
}): PerpExecutionError | null => snapshot.context.lastError;

export const createHyperliquidPerpRunner = ({
  settings,
  store,
  dependencies = {},
}: {
  readonly settings: HyperliquidExecutionSettings;
  readonly store: PerpOrderStore;
  readonly dependencies?: HyperliquidRequestDependencies;
}): HyperliquidPerpRunner => {
  const signer: OrderSigner = (dependencies.signer ?? createEthersSignerFactory())(
    settings.agentPrivateKey,
  );
  const runnerDependencies: HyperliquidRequestDependencies = {
    ...dependencies,
    signer: () => signer,
  };

  /** Signe une seule fois ; la soumission rejoue le payload signé. */
  const signOnce = async (
    intent: PerpOrderIntent,
    clientOrderId: string,
  ): Promise<
    | { readonly ok: true; readonly submission: HyperliquidSubmission }
    | { readonly ok: false }
  > => {
    const meta = await fetchHyperliquidMeta(settings, runnerDependencies);
    const coin = hyperliquidCoin(intent.productId);
    const assetIndex =
      meta === null || coin === null ? null : assetIndexForCoin(meta, coin);
    if (assetIndex === null) return { ok: false };
    const signed = await signHyperliquidOrder(
      settings,
      intent,
      assetIndex,
      clientOrderId,
      { ...runnerDependencies, signer: () => signer },
    );
    return signed.ok ? { ok: true, submission: signed.value } : { ok: false };
  };

  const finishOutcome = async (
    machine: OrderMachine,
    clientOrderId: string,
  ): Promise<HyperliquidPerpRunResult> => {
    if (machine.getSnapshot().value === "persistingOutcome") {
      try {
        await store.persistOutcome(
          clientOrderId,
          machine.getSnapshot().context.outcome ?? "REJECTED",
          dependencies.now?.() ?? Date.now(),
        );
        machine.send({ type: "PERSIST_SUCCEEDED" });
      } catch {
        machine.send({
          type: "PERSIST_FAILED",
          error: { code: "PERSIST_OUTCOME_FAILED" },
        });
      }
    }
    const final = machine.getSnapshot();
    if (final.value === "settled") {
      return Object.freeze({
        status: "SETTLED",
        outcome: final.context.outcome ?? "REJECTED",
        clientOrderId,
      });
    }
    return Object.freeze({
      status: "FAILED",
      error: failureOf(final) ?? { code: "PERSIST_OUTCOME_FAILED" as const },
    });
  };

  const reconcileInFlight = async (
    machine: OrderMachine,
    clientOrderId: string,
  ): Promise<HyperliquidPerpRunResult> => {
    const issue = await reconcileHyperliquidOrder(
      settings,
      clientOrderId,
      runnerDependencies,
    );
    machine.send(
      issue.kind === "RESOLVED"
        ? { type: "RECONCILIATION_RESOLVED", outcome: issue.outcome }
        : {
            type: "RECONCILIATION_FAILED",
            error: { code: "RECONCILIATION_FAILED" },
          },
    );
    return finishOutcome(machine, clientOrderId);
  };

  return {
    async runOrder({ intent, gate, clientOrderId }) {
      // Premier contrôle : l'admission fermée, avant tout événement.
      const admission = admitHyperliquidPerpConfiguration(
        candidateFor(intent.productId),
      );
      if (admission.status !== "APPROVED") {
        return Object.freeze({
          status: "REFUSED",
          reasonCode: "PERP_ADMISSION_REQUIRED",
        } satisfies HyperliquidPerpRunResult);
      }
      const machine: OrderMachine = createActor(hyperliquidPerpOrderMachine, {
        input: {},
      }).start();
      // Second contrôle : la garde de la machine réévalue la garde de risque.
      machine.send({
        type: "ORDER_INTENT_REQUESTED",
        intent,
        gate,
        clientOrderId,
        signerReady: true,
      });
      if (machine.getSnapshot().value === "idle") {
        return Object.freeze({
          status: "REFUSED",
          reasonCode: machine.getSnapshot().context.lastRefusal ?? "PERP_INTENT_INVALID",
        } satisfies HyperliquidPerpRunResult);
      }
      // persistingIntent : l'intention est persistée avant tout effet réseau.
      if (machine.getSnapshot().value === "persistingIntent") {
        try {
          await store.persistOrderIntent({
            clientOrderId,
            intent,
            createdAt: dependencies.now?.() ?? Date.now(),
          });
          machine.send({ type: "INTENT_PERSIST_SUCCEEDED" });
        } catch {
          machine.send({
            type: "INTENT_PERSIST_FAILED",
            error: { code: "PERSIST_INTENT_FAILED" },
          });
        }
      }
      if (machine.getSnapshot().value === "failed") {
        return Object.freeze({
          status: "FAILED",
          error:
            failureOf(machine.getSnapshot()) ?? { code: "PERSIST_INTENT_FAILED" as const },
        } satisfies HyperliquidPerpRunResult);
      }
      // signing : la signature est produite une seule fois.
      let submission: HyperliquidSubmission | null = null;
      if (machine.getSnapshot().value === "signing") {
        const signed = await signOnce(intent, clientOrderId);
        if (signed.ok) {
          submission = signed.submission;
          machine.send({ type: "ACTION_SIGNED" });
        } else {
          machine.send({
            type: "SIGN_FAILED",
            error: { code: "SIGN_FAILED" },
          });
        }
      }
      if (machine.getSnapshot().value === "failed") {
        return Object.freeze({
          status: "FAILED",
          error: failureOf(machine.getSnapshot()) ?? { code: "SIGN_FAILED" as const },
        } satisfies HyperliquidPerpRunResult);
      }
      // submitting : au plus une soumission du payload signé.
      if (machine.getSnapshot().value === "submitting" && submission !== null) {
        const issue = await submitHyperliquidOrder(
          settings,
          submission,
          runnerDependencies,
        );
        machine.send(
          issue.kind === "ACCEPTED"
            ? { type: "SUBMIT_ACCEPTED" }
            : issue.kind === "REJECTED"
              ? { type: "SUBMIT_REJECTED" }
              : { type: "SUBMIT_UNKNOWN" },
        );
      }
      if (machine.getSnapshot().value === "reconciling") {
        return reconcileInFlight(machine, clientOrderId);
      }
      return finishOutcome(machine, clientOrderId);
    },
    async recoverPending() {
      const pending = await store.loadUnresolvedOrderIntents();
      let recovered = 0;
      for (const record of pending) {
        const machine: OrderMachine = createActor(hyperliquidPerpOrderMachine, {
          input: {},
        }).start();
        machine.send({
          type: "ORDER_RECOVERY_REQUESTED",
          intent: record.intent,
          clientOrderId: record.clientOrderId,
        });
        if (machine.getSnapshot().value !== "reconciling") continue;
        const result = await reconcileInFlight(machine, record.clientOrderId);
        if (result.status === "SETTLED") recovered += 1;
      }
      return Object.freeze({
        recovered,
        unresolved: pending.length - recovered,
      });
    },
  };
};
