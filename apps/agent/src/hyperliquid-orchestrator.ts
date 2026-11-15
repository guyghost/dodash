import {
  admitHyperliquidPerpConfiguration,
  hyperliquidPerpOrderMachine,
  HYPERLIQUID_PERP_POLICY,
  type HyperliquidOrderOutcome,
  type HyperliquidPerpCandidate,
  type PerpExecutionError,
  type PerpFillFact,
  type PerpOrderIntent,
  type PerpRefusalCode,
  type PerpRiskGate,
} from "@dodash/models";
import { createActor } from "xstate";

import {
  assetIndexForCoin,
  fetchHyperliquidMeta,
  fetchHyperliquidOrderFills,
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
  /**
   * Persistance idempotente des fills réconciliés (dao #31) : insert
   * only, jamais de rétroécriture. Un échec n'est jamais un échec de
   * cycle (C3, models/hyperliquid-fill-persistence.md §2.4).
   */
  persistFills(
    clientOrderId: string,
    fills: readonly PerpFillFact[],
    persistedAt: number,
  ): Promise<void>;
  /**
   * Détection lecture-seule des créneaux de rattrapage (dao #33) : les
   * ordres résolus ACCEPTED sans aucune ligne de fill, ordre
   * déterministe (le plus récemment réglé d'abord), borné LIMIT.
   * Aucune écriture — source de vérité :
   * models/hyperliquid-fill-persistence.md §2.5.
   */
  loadAcceptedOrderIdsMissingFills(limit: number): Promise<readonly string[]>;
  loadUnresolvedOrderIntents(): Promise<readonly PerpOrderRecord[]>;
}

export const createInMemoryPerpOrderStore = (): PerpOrderStore => {
  const intents = new Map<string, PerpOrderRecord>();
  const outcomes = new Map<string, HyperliquidOrderOutcome>();
  const fills = new Map<string, PerpFillFact>();
  return {
    async persistOrderIntent(record) {
      intents.set(record.clientOrderId, record);
    },
    async persistOutcome(clientOrderId, outcome) {
      outcomes.set(clientOrderId, outcome);
    },
    async persistFills(clientOrderId, persisted) {
      for (const fill of persisted) {
        const key = `${clientOrderId}:${fill.fillId}`;
        if (!fills.has(key)) fills.set(key, fill);
      }
    },
    async loadAcceptedOrderIdsMissingFills(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("INVALID_PERP_FILL_BACKFILL_LIMIT");
      }
      // L'ordre d'insertion de `outcomes` est l'ordre de règlement ; le
      // parcours inverse est le plus récemment réglé d'abord,
      // déterministe (équivalent in-memory de settled_at DESC).
      const gaps: string[] = [];
      for (const [clientOrderId, outcome] of [...outcomes].reverse()) {
        if (outcome !== "ACCEPTED") continue;
        const prefix = `${clientOrderId}:`;
        let hasFill = false;
        for (const key of fills.keys()) {
          if (key.startsWith(prefix)) {
            hasFill = true;
            break;
          }
        }
        if (!hasFill) {
          gaps.push(clientOrderId);
          if (gaps.length === limit) break;
        }
      }
      return gaps;
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
  /**
   * Lectures/écritures de fills en échec (dao #31) : signal de sortie
   * télémétrie, jamais une décision (C3).
   */
  readonly fillPersistenceFailures: number;
  /**
   * Rattrapage borné des fills manqués (dao #33, §2.5) : créneaux
   * comblés / en échec / tournés sans fill, et plafond atteint
   * (rattrapage partiel, reste reporté au cycle suivant). Signal de
   * sortie only — `recovered`/`unresolved` comptent les seuls ordres
   * en vol.
   */
  readonly fillBackfillFilled: number;
  readonly fillBackfillFailures: number;
  readonly fillBackfillUnresolved: number;
  readonly fillBackfillTruncated: boolean;
}

/**
 * Plafond de rattrapage par cycle de reprise (dao #33, §2.5) : au plus
 * N créneaux relus par cycle, chaque lecture étant plafonnée par la
 * couture (#31/#27 : 1 MiB, timeout, erreurs fermées). Un ordre de
 * grandeur sous la fenêtre de projection (50 ordres) ; la répétition
 * cyclique couvre le reste, récemment réglé d'abord.
 */
export const PERP_FILL_BACKFILL_MAX_GAPS_PER_CYCLE = 10;

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

  /**
   * Compteur télémétrie des fills non persistés (dao #31, C3) : échec
   * de lecture ou d'écriture des fills. Signal de sortie only — jamais
   * un événement de machine, jamais un échec de cycle.
   */
  let fillPersistenceFailures = 0;

  /**
   * Issue fermée d'une lecture+persistance de fills (dao #31/#33) :
   * PERSISTED (≥ 1 fill écrit), EMPTY (venue sans fill pour le cloid),
   * READ_FAILED, WRITE_FAILED. Les échecs sont déjà consignés (log
   * structuré + compteur) par cette fonction — jamais rehaussés.
   */
  type FillPersistIssue =
    | { readonly kind: "PERSISTED"; readonly count: number }
    | { readonly kind: "EMPTY" }
    | { readonly kind: "READ_FAILED" }
    | { readonly kind: "WRITE_FAILED" };

  /**
   * Lecture venue des fills d'un ordre accepté, puis persistance
   * idempotente via le port. Sobre : une seule tentative par clôture
   * d'issue, aucun retry, aucune ligne inventée en cas d'absence.
   * Source de vérité : models/hyperliquid-fill-persistence.md §2.3–2.5.
   */
  const persistReconciledFills = async (
    clientOrderId: string,
  ): Promise<FillPersistIssue> => {
    let fills: readonly PerpFillFact[] | null = null;
    try {
      fills = await fetchHyperliquidOrderFills(
        settings,
        clientOrderId,
        runnerDependencies,
      );
    } catch {
      fills = null;
    }
    if (fills === null) {
      fillPersistenceFailures += 1;
      console.error(
        JSON.stringify({
          type: "PERP_FILLS_UNAVAILABLE",
          clientOrderId,
          fillPersistenceFailures,
        }),
      );
      return { kind: "READ_FAILED" };
    }
    // Aucun fill : aucune ligne inventée (invariant 9).
    if (fills.length === 0) return { kind: "EMPTY" };
    try {
      await store.persistFills(
        clientOrderId,
        fills,
        dependencies.now?.() ?? Date.now(),
      );
    } catch {
      fillPersistenceFailures += 1;
      console.error(
        JSON.stringify({
          type: "PERP_FILL_PERSIST_FAILED",
          clientOrderId,
          fillPersistenceFailures,
        }),
      );
      return { kind: "WRITE_FAILED" };
    }
    return { kind: "PERSISTED", count: fills.length };
  };

  /**
   * Rattrapage borné des fills manqués (dao #33, §2.5) : détecte les
   * créneaux (ordres ACCEPTED sans fill, lecture-seule), relis au plus
   * PERP_FILL_BACKFILL_MAX_GAPS_PER_CYCLE d'entre eux en ordre
   * déterministe via la même couture, insertion idempotente. Plafond
   * atteint ⇒ rattrapage partiel consigné (`fillBackfillTruncated`) et
   * reporté : un créneau ne sort de la détection que comblé. Un échec
   * de rattrapage est un log + un compteur, jamais un échec de cycle
   * (invariant 12) — la détection impossible annule le rattrapage sans
   * toucher à la reprise des ordres en vol.
   */
  const backfillMissingFills = async (): Promise<{
    readonly fillBackfillFilled: number;
    readonly fillBackfillFailures: number;
    readonly fillBackfillUnresolved: number;
    readonly fillBackfillTruncated: boolean;
  }> => {
    let detected: readonly string[];
    try {
      detected = await store.loadAcceptedOrderIdsMissingFills(
        PERP_FILL_BACKFILL_MAX_GAPS_PER_CYCLE + 1,
      );
    } catch {
      console.error(
        JSON.stringify({
          type: "PERP_FILL_BACKFILL_DETECTION_FAILED",
        }),
      );
      return {
        fillBackfillFilled: 0,
        fillBackfillFailures: 1,
        fillBackfillUnresolved: 0,
        fillBackfillTruncated: false,
      };
    }
    const scanned = detected.slice(0, PERP_FILL_BACKFILL_MAX_GAPS_PER_CYCLE);
    const truncated = detected.length > PERP_FILL_BACKFILL_MAX_GAPS_PER_CYCLE;
    let filled = 0;
    let failures = 0;
    let unresolved = 0;
    for (const clientOrderId of scanned) {
      const issue = await persistReconciledFills(clientOrderId);
      if (issue.kind === "PERSISTED") filled += 1;
      else {
        unresolved += 1;
        if (issue.kind !== "EMPTY") failures += 1;
      }
    }
    console.log(
      JSON.stringify({
        type: "PERP_FILL_BACKFILL",
        scanned: scanned.length,
        filled,
        failures,
        unresolved,
        truncated,
      }),
    );
    return {
      fillBackfillFilled: filled,
      fillBackfillFailures: failures,
      fillBackfillUnresolved: unresolved,
      fillBackfillTruncated: truncated,
    };
  };

  const finishOutcome = async (
    machine: OrderMachine,
    clientOrderId: string,
    fillsHandled = false,
  ): Promise<HyperliquidPerpRunResult> => {
    if (machine.getSnapshot().value === "persistingOutcome") {
      const outcome = machine.getSnapshot().context.outcome ?? "REJECTED";
      // Un ordre accepté sans incertitude ne repasse jamais par la
      // réconciliation : la lecture des fills est attachée à cet effet
      // de clôture (models/hyperliquid-fill-persistence.md §2.3). Les
      // fills précèdent l'issue : un ordre settled a ses fills écrits.
      if (outcome === "ACCEPTED" && !fillsHandled) {
        await persistReconciledFills(clientOrderId);
      }
      try {
        await store.persistOutcome(
          clientOrderId,
          outcome,
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
        fillPersistenceFailures,
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
    // Effet de réconciliation enrichi (dao #31) : les fills d'une issue
    // résolue ACCEPTED sont persistés avant l'événement de résolution —
    // sans jamais bloquer ni faire échouer la réconciliation (C3).
    if (issue.kind === "RESOLVED" && issue.outcome === "ACCEPTED") {
      await persistReconciledFills(clientOrderId);
    }
    machine.send(
      issue.kind === "RESOLVED"
        ? { type: "RECONCILIATION_RESOLVED", outcome: issue.outcome }
        : {
            type: "RECONCILIATION_FAILED",
            error: { code: "RECONCILIATION_FAILED" },
          },
    );
    return finishOutcome(machine, clientOrderId, true);
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
      // Rattrapage borné des créneaux sans fill (dao #33, §2.5) : après
      // la reprise des ordres en vol, jamais entrelacé avec elle — son
      // échec éventuel n'altère ni `recovered` ni `unresolved`.
      const backfill = await backfillMissingFills();
      return Object.freeze({
        recovered,
        unresolved: pending.length - recovered,
        fillPersistenceFailures,
        ...backfill,
      });
    },
  };
};
