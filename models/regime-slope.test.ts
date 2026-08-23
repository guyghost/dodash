import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import {
  classifyRegimeObservation,
  isValidRegimeFilterPolicy,
} from "./regime-filter.js";
import { regimeFilterMachine } from "./regime-filter.machine.js";
import type { RegimeFilterPolicy } from "./regime-filter.types.js";

const slopePolicy = {
  mode: "EMA_SLOPE",
  slopeThresholdBps: 100,
  slopePeriods: 3,
  minObservations: 1,
  confirmationCount: 2,
} as const;

const slopeObs = (start: number, emaSlow: number) => ({
  start,
  emaFast: emaSlow,
  emaSlow,
});

const slopeCandle = (start: number, emaSlow: number) => ({
  type: "CANDLE_CLOSED" as const,
  observation: slopeObs(start, emaSlow),
});

describe("regime slope classifier (modèle regime-slope.md)", () => {
  it("retourne null (pending) tant que l'historique est plus court que slopePeriods", () => {
    expect(classifyRegimeObservation(slopePolicy, slopeObs(1, 103))).toBeNull();
    expect(
      classifyRegimeObservation(slopePolicy, slopeObs(1, 103), [100]),
    ).toBeNull();
    expect(
      classifyRegimeObservation(slopePolicy, slopeObs(1, 103), [100, 101]),
    ).toBeNull();
  });

  it("classe BULLISH/BEARISH selon la pente sur la fenêtre", () => {
    expect(
      classifyRegimeObservation(slopePolicy, slopeObs(1, 103), [100, 101, 102]),
    ).toBe("BULLISH");
    expect(
      classifyRegimeObservation(slopePolicy, slopeObs(1, 97), [102, 101, 100]),
    ).toBe("BEARISH");
  });

  it("classe RANGE quand la pente reste sous le seuil", () => {
    expect(
      classifyRegimeObservation(
        slopePolicy,
        slopeObs(1, 100.5),
        [100, 100.2, 100.4],
      ),
    ).toBe("RANGE");
  });

  it("traite une pente exactement au seuil comme RANGE (inégalités strictes)", () => {
    expect(
      classifyRegimeObservation(slopePolicy, slopeObs(1, 101), [
        100, 100, 100,
      ]),
    ).toBe("RANGE");
    expect(
      classifyRegimeObservation(slopePolicy, slopeObs(1, 99), [100, 100, 100]),
    ).toBe("RANGE");
  });

  it("EMA_THRESHOLD ignore l'historique et n'est jamais pending", () => {
    const thresholdPolicy = {
      mode: "EMA_THRESHOLD",
      thresholdBps: 100,
      minObservations: 1,
      confirmationCount: 1,
    } as const;
    expect(
      classifyRegimeObservation(
        thresholdPolicy,
        slopeObs(1, 102),
        [100, 101, 102],
      ),
    ).toBe("RANGE");
  });
});

describe("regime slope policy validation (R6)", () => {
  it("accepte une politique EMA_SLOPE valide", () => {
    expect(isValidRegimeFilterPolicy(slopePolicy)).toBe(true);
  });

  it("rejette slopeThresholdBps hors bornes", () => {
    expect(
      isValidRegimeFilterPolicy({ ...slopePolicy, slopeThresholdBps: 0 }),
    ).toBe(false);
    expect(
      isValidRegimeFilterPolicy({ ...slopePolicy, slopeThresholdBps: 10_000 }),
    ).toBe(false);
    expect(
      isValidRegimeFilterPolicy({ ...slopePolicy, slopeThresholdBps: Number.NaN }),
    ).toBe(false);
  });

  it("rejette slopePeriods non entier ou < 1", () => {
    expect(isValidRegimeFilterPolicy({ ...slopePolicy, slopePeriods: 0 })).toBe(
      false,
    );
    expect(
      isValidRegimeFilterPolicy({ ...slopePolicy, slopePeriods: 1.5 }),
    ).toBe(false);
  });

  it("rejette un mode inconnu", () => {
    expect(
      isValidRegimeFilterPolicy({
        ...slopePolicy,
        mode: "EMA_MAGIC",
      } as unknown as RegimeFilterPolicy),
    ).toBe(false);
  });

  it("rejette EMA_THRESHOLD sans thresholdBps", () => {
    expect(
      isValidRegimeFilterPolicy({
        mode: "EMA_THRESHOLD",
        minObservations: 1,
        confirmationCount: 1,
      } as unknown as RegimeFilterPolicy),
    ).toBe(false);
  });
});

describe("regime slope machine", () => {
  it("warm-up : pending compte et historise sans streak (R1, R2), entrée après confirmation (I12)", () => {
    const actor = createActor(regimeFilterMachine, {
      input: { policy: slopePolicy },
    });
    actor.start();

    // 3 observations pending : historique insuffisant.
    for (const [start, emaSlow] of [
      [1, 100],
      [2, 101],
      [3, 102],
    ] as const) {
      actor.send(slopeCandle(start, emaSlow));
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe("warmingUp");
      expect(snapshot.context.observationCount).toBe(start);
      expect(snapshot.context.pendingKind).toBeNull();
      expect(snapshot.context.pendingCount).toBe(0);
    }
    // L'historique est saturé à slopePeriods mais la classification n'a lieu
    // qu'à partir de l'observation suivante.
    expect(actor.getSnapshot().context.emaSlowHistory).toEqual([100, 101, 102]);

    // 4e observation : pente +3 % → BULLISH, streak 1 < confirmation 2.
    actor.send(slopeCandle(4, 103));
    let snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("warmingUp");
    expect(snapshot.context.pendingKind).toBe("BULLISH");
    expect(snapshot.context.pendingCount).toBe(1);

    // 5e observation : pente +2,97 % → BULLISH, streak 2 → entrée.
    actor.send(slopeCandle(5, 104));
    snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("regimeBullish");
    expect(snapshot.context.regime).toBe("BULLISH");
    expect(snapshot.context.observationCount).toBe(5);
  });

  it("borne l'historique à slopePeriods entrées (R4)", () => {
    const actor = createActor(regimeFilterMachine, {
      input: { policy: slopePolicy },
    });
    actor.start();
    for (const [start, emaSlow] of [
      [1, 100],
      [2, 101],
      [3, 102],
      [4, 103],
      [5, 104],
    ] as const) {
      actor.send(slopeCandle(start, emaSlow));
    }
    expect(actor.getSnapshot().context.emaSlowHistory).toEqual([102, 103, 104]);
  });

  it("hystérésis : switch de régime seulement après confirmation opposée", () => {
    const actor = createActor(regimeFilterMachine, {
      input: { policy: slopePolicy },
    });
    actor.start();
    for (const [start, emaSlow] of [
      [1, 100],
      [2, 101],
      [3, 102],
      [4, 103],
      [5, 104],
    ] as const) {
      actor.send(slopeCandle(start, emaSlow));
    }
    expect(actor.getSnapshot().value).toBe("regimeBullish");

    // Référence = 102 → 99/102 ≈ −2,94 % : BEARISH streak 1, pas de switch.
    actor.send(slopeCandle(6, 99));
    let snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("regimeBullish");
    expect(snapshot.context.opposingKind).toBe("BEARISH");
    expect(snapshot.context.opposingCount).toBe(1);

    // Référence = 103 → 97/103 ≈ −5,8 % : BEARISH streak 2 → switch.
    actor.send(slopeCandle(7, 97));
    snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("regimeBearish");
    expect(snapshot.context.regime).toBe("BEARISH");
  });

  it("entrée au plus tôt à max(minObservations, slopePeriods + 1) + (confirmation − 1)", () => {
    const actor = createActor(regimeFilterMachine, {
      input: { policy: { ...slopePolicy, minObservations: 5 } },
    });
    actor.start();
    for (const [start, emaSlow] of [
      [1, 100],
      [2, 101],
      [3, 102],
      [4, 103],
    ] as const) {
      actor.send(slopeCandle(start, emaSlow));
    }
    // Obs 4 : BULLISH streak 2, mais observationCount+1 = 4 < minObservations 5.
    expect(actor.getSnapshot().value).toBe("warmingUp");
    actor.send(slopeCandle(5, 104));
    expect(actor.getSnapshot().value).toBe("regimeBullish");
  });

  it("slopePeriods = 1 : classification dès la 2e observation", () => {
    const actor = createActor(regimeFilterMachine, {
      input: {
        policy: { ...slopePolicy, slopePeriods: 1, confirmationCount: 1 },
      },
    });
    actor.start();
    actor.send(slopeCandle(1, 100));
    expect(actor.getSnapshot().value).toBe("warmingUp");
    // +3 % vs observation précédente → entrée immédiate.
    actor.send(slopeCandle(2, 103));
    expect(actor.getSnapshot().value).toBe("regimeBullish");
  });
});
