import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import {
  classifyRegimeObservation,
  DEFAULT_REGIME_PERMISSIONS,
  isValidRegimeFilterPolicy,
  isValidRegimeObservation,
  resolveRegimePermission,
} from "./regime-filter.js";
import { regimeFilterMachine } from "./regime-filter.machine.js";
import type {
  RegimeKind,
  RegimeObservation,
  RegimePermissions,
} from "./regime-filter.types.js";

const policy = {
  mode: "EMA_THRESHOLD",
  thresholdBps: 100,
  minObservations: 3,
  confirmationCount: 2,
} as const;

const makeObservation = (
  start: number,
  kind: RegimeKind,
): RegimeObservation => {
  if (kind === "BULLISH") return { start, emaFast: 102, emaSlow: 100 };
  if (kind === "BEARISH") return { start, emaFast: 98, emaSlow: 100 };
  return { start, emaFast: 100, emaSlow: 100 };
};

const candle = (start: number, kind: RegimeKind) => ({
  type: "CANDLE_CLOSED" as const,
  observation: makeObservation(start, kind),
});

describe("regime filter core", () => {
  it("classe bullish/bearish/range depuis les EMAs", () => {
    expect(classifyRegimeObservation(policy, makeObservation(1, "BULLISH"))).toBe(
      "BULLISH",
    );
    expect(classifyRegimeObservation(policy, makeObservation(1, "BEARISH"))).toBe(
      "BEARISH",
    );
    expect(classifyRegimeObservation(policy, makeObservation(1, "RANGE"))).toBe(
      "RANGE",
    );
  });

  it("traite un écart exactement au seuil comme RANGE (inégalités strictes)", () => {
    expect(
      classifyRegimeObservation(policy, { start: 1, emaFast: 101, emaSlow: 100 }),
    ).toBe("RANGE");
    expect(
      classifyRegimeObservation(policy, { start: 1, emaFast: 99, emaSlow: 100 }),
    ).toBe("RANGE");
  });

  it("rejette les politiques invalides", () => {
    expect(isValidRegimeFilterPolicy(policy)).toBe(true);
    expect(
      isValidRegimeFilterPolicy({ ...policy, thresholdBps: 0 }),
    ).toBe(false);
    expect(
      isValidRegimeFilterPolicy({ ...policy, thresholdBps: 10_000 }),
    ).toBe(false);
    expect(
      isValidRegimeFilterPolicy({ ...policy, minObservations: 1.5 }),
    ).toBe(false);
    expect(
      isValidRegimeFilterPolicy({ ...policy, confirmationCount: 0 }),
    ).toBe(false);
  });

  it("RA2 : valide bearishThresholdBps seulement s'il est présent et borné", () => {
    expect(
      isValidRegimeFilterPolicy({ ...policy, bearishThresholdBps: 200 }),
    ).toBe(true);
    expect(
      isValidRegimeFilterPolicy({ ...policy, bearishThresholdBps: 0 }),
    ).toBe(false);
    expect(
      isValidRegimeFilterPolicy({ ...policy, bearishThresholdBps: 10_000 }),
    ).toBe(false);
    expect(
      isValidRegimeFilterPolicy({ ...policy, bearishThresholdBps: 1.5 }),
    ).toBe(true);
  });

  it("RA3 : l'asymétrie ne touche que la branche BEARISH", () => {
    // gap ≈ −150 bps : BEARISH au seuil symétrique 100, RANGE au seuil bear 200.
    const dip = { start: 1, emaFast: 98.5, emaSlow: 100 } as const;
    const asymmetric = { ...policy, bearishThresholdBps: 200 };
    expect(classifyRegimeObservation(policy, dip)).toBe("BEARISH");
    expect(classifyRegimeObservation(asymmetric, dip)).toBe("RANGE");
    // gap ≈ −300 bps : BEARISH dans les deux cas.
    const trend = { start: 1, emaFast: 97, emaSlow: 100 } as const;
    expect(classifyRegimeObservation(policy, trend)).toBe("BEARISH");
    expect(classifyRegimeObservation(asymmetric, trend)).toBe("BEARISH");
    // BULLISH/RANGE inchangés par l'asymétrie.
    expect(classifyRegimeObservation(asymmetric, makeObservation(1, "BULLISH"))).toBe(
      "BULLISH",
    );
    expect(classifyRegimeObservation(asymmetric, makeObservation(1, "RANGE"))).toBe(
      "RANGE",
    );
  });

  it("RA1 : bearishThresholdBps absent → classification bit-identique v1", () => {
    const gaps = [
      { emaFast: 102, emaSlow: 100 },
      { emaFast: 99, emaSlow: 100 },
      { emaFast: 97, emaSlow: 100 },
      { emaFast: 100.5, emaSlow: 100 },
      { emaFast: 98.9999999, emaSlow: 100 },
    ];
    for (const [index, gap] of gaps.entries()) {
      const observation = { start: index + 1, ...gap } as RegimeObservation;
      expect(classifyRegimeObservation(policy, observation)).toBe(
        classifyRegimeObservation(
          { ...policy, bearishThresholdBps: policy.thresholdBps },
          observation,
        ),
      );
    }
  });

  it("rejette les observations invalides (timestamp régressif, EMA non finie)", () => {
    expect(isValidRegimeObservation(makeObservation(1, "RANGE"), null)).toBe(
      true,
    );
    expect(isValidRegimeObservation(makeObservation(1, "RANGE"), 1)).toBe(false);
    expect(isValidRegimeObservation(makeObservation(3, "RANGE"), 2)).toBe(true);
    expect(
      isValidRegimeObservation({ start: 1, emaFast: NaN, emaSlow: 100 }, null),
    ).toBe(false);
    expect(
      isValidRegimeObservation({ start: 0, emaFast: 100, emaSlow: 100 }, null),
    ).toBe(false);
    expect(
      isValidRegimeObservation({ start: 1.5, emaFast: 100, emaSlow: 100 }, null),
    ).toBe(false);
  });

  it("autorise par défaut uniquement les stratégies ancrées dans les backtests", () => {
    expect(resolveRegimePermission("BULLISH", "ema-cross")).toEqual({
      ok: true,
      value: true,
    });
    expect(resolveRegimePermission("BULLISH", "rsi-reversion")).toEqual({
      ok: true,
      value: false,
    });
    expect(resolveRegimePermission("BEARISH", "rsi-reversion")).toEqual({
      ok: true,
      value: true,
    });
    expect(resolveRegimePermission("BEARISH", "breakout")).toEqual({
      ok: true,
      value: false,
    });
    expect(resolveRegimePermission("RANGE", "rsi-reversion")).toEqual({
      ok: true,
      value: true,
    });
  });

  it("refuse (deny) toute stratégie absente de la table de permissions", () => {
    expect(resolveRegimePermission("BULLISH", "stratégie-inconnue")).toEqual({
      ok: true,
      value: false,
    });
  });

  it("retourne INVALID_REGIME_POLICY si un régime manque de la table", () => {
    const incomplete = { BULLISH: ["ema-cross"] } as unknown as RegimePermissions;
    expect(resolveRegimePermission("BEARISH", "rsi-reversion", incomplete))
      .toEqual({
        ok: false,
        error: { code: "INVALID_REGIME_POLICY" },
      });
  });

  it("couvre les trois régimes dans les permissions par défaut", () => {
    for (const regime of ["BULLISH", "BEARISH", "RANGE"] as const) {
      expect(DEFAULT_REGIME_PERMISSIONS[regime]).toBeDefined();
    }
  });
});

describe("regime filter machine", () => {
  it("échoue immédiatement sur une politique invalide", () => {
    const actor = createActor(regimeFilterMachine, {
      input: { policy: { ...policy, thresholdBps: 0 } },
    });
    actor.start();

    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.lastError).toEqual({
      code: "INVALID_REGIME_POLICY",
    });
    expect(actor.getSnapshot().status).toBe("done");
  });

  it("reste en warmingUp tant que minObservations n'est pas atteint", () => {
    const actor = createActor(regimeFilterMachine, { input: { policy } });
    actor.start();

    expect(actor.getSnapshot().value).toBe("warmingUp");

    actor.send(candle(1_000, "BULLISH"));
    actor.send(candle(1_100, "BULLISH"));
    expect(actor.getSnapshot().value).toBe("warmingUp");
    expect(actor.getSnapshot().context.observationCount).toBe(2);
    expect(actor.getSnapshot().context.regime).toBeNull();
  });

  it("entre dans chaque régime après warm-up confirmé", () => {
    for (const kind of ["BULLISH", "BEARISH", "RANGE"] as const) {
      const actor = createActor(regimeFilterMachine, { input: { policy } });
      actor.start();
      actor.send(candle(1_000, kind));
      actor.send(candle(1_100, kind));
      actor.send(candle(1_200, kind));

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe(`regime${kind.charAt(0)}${kind.slice(1).toLowerCase()}`);
      expect(snapshot.context.regime).toBe(kind);
      expect(snapshot.context.observationCount).toBe(3);
    }
  });

  it("hystérésis : une observation adverse isolée ne bascule pas le régime", () => {
    const actor = createActor(regimeFilterMachine, { input: { policy } });
    actor.start();
    actor.send(candle(1_000, "BULLISH"));
    actor.send(candle(1_100, "BULLISH"));
    actor.send(candle(1_200, "BULLISH"));
    expect(actor.getSnapshot().value).toBe("regimeBullish");

    actor.send(candle(1_300, "BEARISH"));
    expect(actor.getSnapshot().value).toBe("regimeBullish");
    expect(actor.getSnapshot().context.opposingKind).toBe("BEARISH");
    expect(actor.getSnapshot().context.opposingCount).toBe(1);
  });

  it("hystérésis : une observation conforme réinitialise la série adverse", () => {
    const actor = createActor(regimeFilterMachine, { input: { policy } });
    actor.start();
    actor.send(candle(1_000, "BULLISH"));
    actor.send(candle(1_100, "BULLISH"));
    actor.send(candle(1_200, "BULLISH"));

    actor.send(candle(1_300, "BEARISH"));
    actor.send(candle(1_400, "BULLISH"));
    expect(actor.getSnapshot().context.opposingKind).toBeNull();
    expect(actor.getSnapshot().context.opposingCount).toBe(0);

    actor.send(candle(1_500, "BEARISH"));
    expect(actor.getSnapshot().value).toBe("regimeBullish");
    expect(actor.getSnapshot().context.opposingCount).toBe(1);
  });

  it("hystérésis : confirmationCount consécutives adverses basculent le régime", () => {
    const actor = createActor(regimeFilterMachine, { input: { policy } });
    actor.start();
    actor.send(candle(1_000, "BULLISH"));
    actor.send(candle(1_100, "BULLISH"));
    actor.send(candle(1_200, "BULLISH"));

    actor.send(candle(1_300, "BEARISH"));
    expect(actor.getSnapshot().value).toBe("regimeBullish");
    actor.send(candle(1_400, "BEARISH"));
    expect(actor.getSnapshot().value).toBe("regimeBearish");
    expect(actor.getSnapshot().context.regime).toBe("BEARISH");
    expect(actor.getSnapshot().context.opposingCount).toBe(0);
  });

  it("échoue sur une observation avec timestamp régressif", () => {
    const actor = createActor(regimeFilterMachine, { input: { policy } });
    actor.start();
    actor.send(candle(1_000, "BULLISH"));
    actor.send(candle(900, "BULLISH"));

    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.lastError).toEqual({
      code: "INVALID_REGIME_OBSERVATION",
    });
    expect(actor.getSnapshot().status).toBe("done");
  });

  it("échoue sur une EMA non finie, même en régime stable", () => {
    const actor = createActor(regimeFilterMachine, { input: { policy } });
    actor.start();
    actor.send(candle(1_000, "BULLISH"));
    actor.send(candle(1_100, "BULLISH"));
    actor.send(candle(1_200, "BULLISH"));
    actor.send({
      type: "CANDLE_CLOSED",
      observation: { start: 1_300, emaFast: Number.POSITIVE_INFINITY, emaSlow: 100 },
    });

    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.lastError).toEqual({
      code: "INVALID_REGIME_OBSERVATION",
    });
  });

  it("s'arrête proprement sur STOP_REQUESTED depuis warmingUp", () => {
    const actor = createActor(regimeFilterMachine, { input: { policy } });
    actor.start();
    actor.send(candle(1_000, "BULLISH"));
    actor.send({ type: "STOP_REQUESTED", reason: "OPERATOR_STOP" });

    expect(actor.getSnapshot().value).toBe("stopped");
    expect(actor.getSnapshot().context.stopReason).toBe("OPERATOR_STOP");
    expect(actor.getSnapshot().status).toBe("done");
  });

  it("s'arrête proprement sur STOP_REQUESTED depuis un régime actif", () => {
    const actor = createActor(regimeFilterMachine, { input: { policy } });
    actor.start();
    actor.send(candle(1_000, "RANGE"));
    actor.send(candle(1_100, "RANGE"));
    actor.send(candle(1_200, "RANGE"));
    actor.send({ type: "STOP_REQUESTED", reason: "SESSION_END" });

    expect(actor.getSnapshot().value).toBe("stopped");
    expect(actor.getSnapshot().context.stopReason).toBe("SESSION_END");
  });

  it("ignore tout événement une fois terminal (stopped/failed)", () => {
    const stopped = createActor(regimeFilterMachine, { input: { policy } });
    stopped.start();
    stopped.send({ type: "STOP_REQUESTED", reason: "OPERATOR_STOP" });
    stopped.send(candle(1_000, "BULLISH"));
    expect(stopped.getSnapshot().value).toBe("stopped");

    const failed = createActor(regimeFilterMachine, {
      input: { policy: { ...policy, thresholdBps: -1 } },
    });
    failed.start();
    failed.send(candle(1_000, "BULLISH"));
    expect(failed.getSnapshot().value).toBe("failed");
  });

  it("invariant : les permissions suivent le régime courant du contexte", () => {
    const actor = createActor(regimeFilterMachine, { input: { policy } });
    actor.start();
    actor.send(candle(1_000, "BEARISH"));
    actor.send(candle(1_100, "BEARISH"));
    actor.send(candle(1_200, "BEARISH"));

    const regime = actor.getSnapshot().context.regime;
    expect(regime).toBe("BEARISH");
    expect(resolveRegimePermission(regime as RegimeKind, "rsi-reversion")).toEqual({
      ok: true,
      value: true,
    });
    expect(
      resolveRegimePermission(regime as RegimeKind, "ema-cross"),
    ).toEqual({ ok: true, value: false });
  });
});
