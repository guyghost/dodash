import { describe, expect, it } from "vitest";

import {
  alignRetryInstant,
  MARKET_RETRY_DELAYS_MS,
  MARKET_RETRY_MAX_DELAY_MS,
  MARKET_RETRY_MAX_REARMS,
  planMarketRetry,
  resolveMarketRetryDeadline,
  resolveRetryWake,
} from "./market-retry-schedule.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T = Date.UTC(2026, 8, 27, 0, 0, 46); // cycle 00:00:46Z
const base = {
  retryLimit: 3,
  retryable: true,
  retryAfterMs: null,
  now: T + 900,
  triggeredAt: T,
  timeframeMs: DAY,
  maxMarketStalenessMs: 2 * HOUR,
};

describe("planMarketRetry", () => {
  it("fige la table des délais", () => {
    expect(MARKET_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 900_000]);
    expect(MARKET_RETRY_MAX_DELAY_MS).toBe(900_000);
  });

  it("dérive l'échéance de la bougie de décision", () => {
    expect(resolveMarketRetryDeadline(T, DAY, 2 * HOUR)).toBe(Date.UTC(2026, 8, 27, 2));
  });

  it("planifie 60 s après le premier 429", () => {
    expect(planMarketRetry({ ...base, attempt: 0 })).toEqual({
      kind: "schedule",
      attempt: 1,
      nextRetryAt: alignRetryInstant(base.now + 60_000),
      deadlineAt: Date.UTC(2026, 8, 27, 2),
    });
  });

  it("espace les tentatives suivantes à 300 s puis 900 s", () => {
    expect(planMarketRetry({ ...base, attempt: 1 })).toMatchObject({ nextRetryAt: alignRetryInstant(base.now + 300_000) });
    expect(planMarketRetry({ ...base, attempt: 2 })).toMatchObject({ nextRetryAt: alignRetryInstant(base.now + 900_000) });
  });

  it("honore Retry-After quand il est plus long, plafonné à 900 s", () => {
    expect(planMarketRetry({ ...base, attempt: 0, retryAfterMs: 120_000 })).toMatchObject({
      nextRetryAt: alignRetryInstant(base.now + 120_000),
    });
    expect(planMarketRetry({ ...base, attempt: 0, retryAfterMs: 1_200_000 })).toMatchObject({
      nextRetryAt: alignRetryInstant(base.now + 900_000),
    });
    expect(planMarketRetry({ ...base, attempt: 0, retryAfterMs: 5_000 })).toMatchObject({
      nextRetryAt: alignRetryInstant(base.now + 60_000),
    });
  });

  it("épuise le budget avant toute planification", () => {
    expect(planMarketRetry({ ...base, attempt: 3 })).toEqual({
      kind: "exhausted",
      reason: "BUDGET",
      deadlineAt: Date.UTC(2026, 8, 27, 2),
    });
  });

  it("refuse toute planification au-delà de l'échéance", () => {
    const late = Date.UTC(2026, 8, 27, 1, 59, 30);
    expect(planMarketRetry({ ...base, attempt: 0, now: late })).toEqual({
      kind: "exhausted",
      reason: "DEADLINE",
      deadlineAt: Date.UTC(2026, 8, 27, 2),
    });
    expect(
      planMarketRetry({ ...base, attempt: 0, now: Date.UTC(2026, 8, 27, 5), triggeredAt: Date.UTC(2026, 8, 27, 5) }),
    ).toMatchObject({ kind: "exhausted", reason: "DEADLINE" });
  });

  it("ne planifie jamais une erreur non retryable", () => {
    expect(planMarketRetry({ ...base, attempt: 0, retryable: false })).toMatchObject({
      kind: "exhausted",
      reason: "NOT_RETRYABLE",
    });
  });

  it("est pure : mêmes entrées, même sortie", () => {
    const input = { ...base, attempt: 1 };
    expect(planMarketRetry(input)).toEqual(planMarketRetry(input));
  });
});

/**
 * Sémantique de l'alarme ponctuelle du SDK `agents` 0.21.0 : la ligne stocke
 * `floor(at / 1 000)` et s'exécute dès `floor(maintenant / 1 000) ≥ time`,
 * soit au plus tôt à `floor(at / 1 000) × 1 000`.
 */
const earliestAlarmFire = (at: number): number => Math.floor(at / 1_000) * 1_000;

describe("alarme anticipée (amendement 2026-10-07)", () => {
  it("reproduit le constat AE : 00:01:00.368 + 60 s ne doit pas réveiller avant l'échéance", () => {
    const now = Date.UTC(2026, 8, 29, 0, 1, 0, 368);
    const plan = planMarketRetry({ ...base, attempt: 0, now, triggeredAt: Date.UTC(2026, 8, 29, 0, 1, 0, 0) });
    expect(plan.kind).toBe("schedule");
    if (plan.kind !== "schedule") return;
    expect(plan.nextRetryAt).toBeGreaterThanOrEqual(now + 60_000);
    expect(earliestAlarmFire(plan.nextRetryAt)).toBeGreaterThanOrEqual(plan.nextRetryAt);
  });

  it("aligne vers le haut sur la seconde, sans toucher un instant déjà aligné", () => {
    expect(alignRetryInstant(1_000)).toBe(1_000);
    expect(alignRetryInstant(1_001)).toBe(2_000);
    expect(alignRetryInstant(1_999)).toBe(2_000);
  });

  it("évalue l'échéance sur l'instant aligné", () => {
    const deadline = Date.UTC(2026, 8, 27, 2);
    // now + 60 s = échéance − 0,5 s : aligné, l'instant dépasse d'une demi-seconde.
    expect(planMarketRetry({ ...base, attempt: 0, now: deadline - 60_500 })).toMatchObject({
      kind: "schedule",
      nextRetryAt: deadline,
    });
    expect(planMarketRetry({ ...base, attempt: 0, now: deadline - 59_500 })).toMatchObject({
      kind: "exhausted",
      reason: "DEADLINE",
    });
  });
});

describe("resolveRetryWake", () => {
  const payload = { productId: "ETH-USD", attempt: 1, nextRetryAt: 421_000, rearm: 0 };

  it("réarme une alarme réveillée avant l'échéance persistée, avec une charge utile distincte", () => {
    expect(resolveRetryWake({ now: 420_999, persistedNextRetryAt: 421_000, payload })).toEqual({
      kind: "rearm",
      at: 421_000,
      payload: { ...payload, rearm: 1 },
    });
  });

  it("borne les réarmements", () => {
    expect(
      resolveRetryWake({
        now: 420_000,
        persistedNextRetryAt: 421_000,
        payload: { ...payload, rearm: MARKET_RETRY_MAX_REARMS },
      }),
    ).toEqual({ kind: "drop" });
  });

  it("exécute le seul produit ciblé à l'échéance", () => {
    expect(resolveRetryWake({ now: 421_000, persistedNextRetryAt: 421_000, payload })).toEqual({
      kind: "run",
      productId: "ETH-USD",
    });
    expect(
      resolveRetryWake({ now: 500_000, persistedNextRetryAt: 421_000, payload: { ...payload, productId: null } }),
    ).toEqual({ kind: "run", productId: null });
  });

  it("juge une charge utile legacy contre l'échéance persistée (alarmes en vol au déploiement)", () => {
    const legacy = { productId: "BTC-USD", attempt: 1 };
    // Échéance legacy non alignée : 00:02:00.368, alarme réveillée à 00:02:00.000.
    expect(resolveRetryWake({ now: 120_000, persistedNextRetryAt: 120_368, payload: legacy })).toEqual({
      kind: "rearm",
      at: 121_000, // aligné : ne peut plus repartir avant 120 368
      payload: { productId: "BTC-USD", attempt: 1, nextRetryAt: 121_000, rearm: 1 },
    });
    expect(resolveRetryWake({ now: 0, persistedNextRetryAt: null, payload: legacy })).toEqual({
      kind: "run",
      productId: "BTC-USD",
    });
    expect(resolveRetryWake({ now: 0, persistedNextRetryAt: null, payload: undefined })).toEqual({
      kind: "run",
      productId: null,
    });
  });
});
