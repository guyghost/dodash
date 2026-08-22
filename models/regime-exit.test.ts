import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import { protectiveOrderMachine } from "./protective-order.machine.js";
import {
  activeProtectivePolicyEquals,
  isValidRegimeConditionalExitPolicy,
  isValidRegimeExitArm,
  resolveRegimeExitArm,
} from "./protective-order.js";
import type {
  ActiveProtectiveExitPolicy,
  RegimeConditionalExitPolicy,
  RegimeExitArm,
} from "./protective-order.types.js";

const fixedArm = (stopLossBps: number, takeProfitBps: number): RegimeExitArm => ({
  mode: "FIXED_BPS",
  stopLossBps,
  takeProfitBps,
});

const policy = (overrides?: Partial<RegimeConditionalExitPolicy>): RegimeConditionalExitPolicy => ({
  mode: "REGIME_CONDITIONAL",
  bullish: { mode: "NONE" },
  bearish: fixedArm(300, 600),
  range: fixedArm(300, 600),
  warmUp: fixedArm(300, 600),
  ...overrides,
});

describe("isValidRegimeExitArm", () => {
  it("accepte NONE et FIXED_BPS dans les bornes", () => {
    expect(isValidRegimeExitArm({ mode: "NONE" })).toBe(true);
    expect(isValidRegimeExitArm(fixedArm(300, 600))).toBe(true);
    expect(isValidRegimeExitArm(fixedArm(1, 99_999))).toBe(true);
  });

  it("rejette les bras hors bornes", () => {
    expect(isValidRegimeExitArm(fixedArm(0, 600))).toBe(false);
    expect(isValidRegimeExitArm(fixedArm(300, 0))).toBe(false);
    expect(isValidRegimeExitArm(fixedArm(10_000, 600))).toBe(false);
    expect(isValidRegimeExitArm(fixedArm(300, 100_000))).toBe(false);
    expect(isValidRegimeExitArm(fixedArm(Number.NaN, 600))).toBe(false);
    expect(isValidRegimeExitArm(fixedArm(300, Number.POSITIVE_INFINITY))).toBe(false);
  });
});

describe("isValidRegimeConditionalExitPolicy", () => {
  it("accepte une politique complète", () => {
    expect(isValidRegimeConditionalExitPolicy(policy())).toBe(true);
  });

  it("rejette si un seul bras est invalide", () => {
    expect(isValidRegimeConditionalExitPolicy(policy({ bullish: fixedArm(0, 600) }))).toBe(false);
    expect(isValidRegimeConditionalExitPolicy(policy({ bearish: fixedArm(300, -1) }))).toBe(false);
    expect(isValidRegimeConditionalExitPolicy(policy({ range: fixedArm(10_001, 600) }))).toBe(false);
    expect(isValidRegimeConditionalExitPolicy(policy({ warmUp: fixedArm(300, 100_001) }))).toBe(false);
  });
});

describe("resolveRegimeExitArm", () => {
  it("mappe chaque régime vers son bras (correspondance totale)", () => {
    const custom = policy({
      bullish: fixedArm(500, 1000),
      bearish: { mode: "NONE" },
      range: fixedArm(150, 300),
      warmUp: fixedArm(50, 100),
    });
    expect(resolveRegimeExitArm(custom, "BULLISH")).toEqual(fixedArm(500, 1000));
    expect(resolveRegimeExitArm(custom, "BEARISH")).toBeNull();
    expect(resolveRegimeExitArm(custom, "RANGE")).toEqual(fixedArm(150, 300));
    expect(resolveRegimeExitArm(custom, null)).toEqual(fixedArm(50, 100));
  });

  it("résout la politique par défaut : bull sans protection, le reste armé", () => {
    expect(resolveRegimeExitArm(policy(), "BULLISH")).toBeNull();
    expect(resolveRegimeExitArm(policy(), "BEARISH")).toEqual(fixedArm(300, 600));
    expect(resolveRegimeExitArm(policy(), "RANGE")).toEqual(fixedArm(300, 600));
    expect(resolveRegimeExitArm(policy(), null)).toEqual(fixedArm(300, 600));
  });

  it("retourne le bras NONE comme null (pas de plan armé)", () => {
    const allNone = policy({
      bearish: { mode: "NONE" },
      range: { mode: "NONE" },
      warmUp: { mode: "NONE" },
    });
    expect(resolveRegimeExitArm(allNone, "BULLISH")).toBeNull();
    expect(resolveRegimeExitArm(allNone, "BEARISH")).toBeNull();
    expect(resolveRegimeExitArm(allNone, "RANGE")).toBeNull();
    expect(resolveRegimeExitArm(allNone, null)).toBeNull();
  });
});

describe("activeProtectivePolicyEquals (RE3 : comparaison effective)", () => {
  it("égalité structurelle, pas identité d'objet", () => {
    const a: ActiveProtectiveExitPolicy = {
      mode: "FIXED_BPS",
      stopLossBps: 300,
      takeProfitBps: 600,
    };
    const b: ActiveProtectiveExitPolicy = {
      mode: "FIXED_BPS",
      stopLossBps: 300,
      takeProfitBps: 600,
    };
    expect(a).not.toBe(b);
    expect(activeProtectivePolicyEquals(a, b)).toBe(true);
  });

  it("différence de paramètres ou de mode", () => {
    const base: ActiveProtectiveExitPolicy = {
      mode: "FIXED_BPS",
      stopLossBps: 300,
      takeProfitBps: 600,
    };
    expect(
      activeProtectivePolicyEquals(base, {
        mode: "FIXED_BPS",
        stopLossBps: 301,
        takeProfitBps: 600,
      }),
    ).toBe(false);
    expect(
      activeProtectivePolicyEquals(base, {
        mode: "FIXED_BPS",
        stopLossBps: 300,
        takeProfitBps: 601,
      }),
    ).toBe(false);
    expect(
      activeProtectivePolicyEquals(base, {
        mode: "ATR_MULTIPLE",
        stopAtrMultiple: 2,
        takeAtrMultiple: 3,
      }),
    ).toBe(false);
  });

  it("gère null des deux côtés", () => {
    expect(activeProtectivePolicyEquals(null, null)).toBe(true);
    expect(activeProtectivePolicyEquals(null, fixedArm(300, 600) as ActiveProtectiveExitPolicy)).toBe(false);
    expect(activeProtectivePolicyEquals(fixedArm(300, 600) as ActiveProtectiveExitPolicy, null)).toBe(false);
  });
});

describe("bras hétérogènes par régime v3 (TRAILING bull)", () => {
  const trailingArm: RegimeExitArm = { mode: "TRAILING_BPS", trailBps: 500 };
  const v3Policy = policy({ bullish: trailingArm });
  const armEvent = {
    type: "ARM_REQUESTED",
    positionId: "position-1",
    quantity: 2,
    averageEntryPrice: 100,
    atr: 2,
    armedAt: 1_000,
  } as const;

  it("valide le bras TRAILING aux bornes partagées du mode (RC2)", () => {
    expect(isValidRegimeExitArm(trailingArm)).toBe(true);
    expect(isValidRegimeConditionalExitPolicy(v3Policy)).toBe(true);
    expect(isValidRegimeExitArm({ mode: "TRAILING_BPS", trailBps: 0 })).toBe(false);
    expect(isValidRegimeExitArm({ mode: "TRAILING_BPS", trailBps: 10_000 })).toBe(false);
    expect(isValidRegimeExitArm({ mode: "TRAILING_BPS", trailBps: Number.NaN })).toBe(false);
    expect(
      isValidRegimeConditionalExitPolicy(
        policy({ bullish: { mode: "TRAILING_BPS", trailBps: 10_001 } }),
      ),
    ).toBe(false);
  });

  it("résout BULLISH vers le bras TRAILING, le reste vers FIXED (v3 §2.2)", () => {
    expect(resolveRegimeExitArm(v3Policy, "BULLISH")).toEqual({
      mode: "TRAILING_BPS",
      trailBps: 500,
    });
    expect(resolveRegimeExitArm(v3Policy, "BEARISH")).toEqual(fixedArm(300, 600));
    expect(resolveRegimeExitArm(v3Policy, "RANGE")).toEqual(fixedArm(300, 600));
    expect(resolveRegimeExitArm(v3Policy, null)).toEqual(fixedArm(300, 600));
  });

  it("identifie la politique résolue du bras via l’égalité de replan (RC4)", () => {
    const resolved = resolveRegimeExitArm(v3Policy, "BULLISH") as ActiveProtectiveExitPolicy;
    expect(
      activeProtectivePolicyEquals(resolved, { mode: "TRAILING_BPS", trailBps: 500 }),
    ).toBe(true);
    expect(
      activeProtectivePolicyEquals(
        resolved,
        { mode: "TRAILING_BPS", trailBps: 500, takeProfitBps: 600 },
      ),
    ).toBe(false);
    expect(
      activeProtectivePolicyEquals(resolved, { mode: "TRAILING_BPS", trailBps: 700 }),
    ).toBe(false);
    expect(
      activeProtectivePolicyEquals(
        resolved,
        fixedArm(300, 600) as ActiveProtectiveExitPolicy,
      ),
    ).toBe(false);
  });

  it("le plan issu du bras TRAILING termine en triggered (RC3)", () => {
    const resolved = resolveRegimeExitArm(v3Policy, "BULLISH");
    if (resolved === null) throw new Error("bullish arm must resolve");
    const actor = createActor(protectiveOrderMachine, {
      input: { policy: resolved },
    }).start();
    actor.send(armEvent);
    actor.send({ type: "CANDLE_OPENED", start: 2_000, open: 101 });
    actor.send({
      type: "CANDLE_RANGE_REPLAYED",
      start: 2_000,
      high: 110,
      low: 90,
    });

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("triggered");
    expect(snapshot.context.resolution).toMatchObject({ kind: "STOP_LOSS" });
  });

  it("au flip de régime : cancel puis re-arm sur un nouvel acteur, anchor réinitialisé (RC5)", () => {
    const bear = resolveRegimeExitArm(v3Policy, "BEARISH") as ActiveProtectiveExitPolicy;
    const bull = resolveRegimeExitArm(v3Policy, "BULLISH") as ActiveProtectiveExitPolicy;
    const bearActor = createActor(protectiveOrderMachine, {
      input: { policy: bear },
    }).start();
    bearActor.send(armEvent);
    bearActor.send({ type: "CANCEL_REQUESTED", reason: "REGIME_CHANGED" });
    expect(bearActor.getSnapshot().value).toBe("cancelled");

    const bullActor = createActor(protectiveOrderMachine, {
      input: { policy: bull },
    }).start();
    bullActor.send({ ...armEvent, averageEntryPrice: 120, armedAt: 3_000 });
    expect(bullActor.getSnapshot().context.plan).toMatchObject({
      anchorPrice: 120,
      stopPrice: 120 * (1 - 500 / 10_000),
      policyMode: "TRAILING_BPS",
    });
  });
});
