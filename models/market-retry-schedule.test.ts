import { describe, expect, it } from "vitest";

import {
  MARKET_RETRY_DELAYS_MS,
  MARKET_RETRY_MAX_DELAY_MS,
  planMarketRetry,
  resolveMarketRetryDeadline,
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
      nextRetryAt: base.now + 60_000,
      deadlineAt: Date.UTC(2026, 8, 27, 2),
    });
  });

  it("espace les tentatives suivantes à 300 s puis 900 s", () => {
    expect(planMarketRetry({ ...base, attempt: 1 })).toMatchObject({ nextRetryAt: base.now + 300_000 });
    expect(planMarketRetry({ ...base, attempt: 2 })).toMatchObject({ nextRetryAt: base.now + 900_000 });
  });

  it("honore Retry-After quand il est plus long, plafonné à 900 s", () => {
    expect(planMarketRetry({ ...base, attempt: 0, retryAfterMs: 120_000 })).toMatchObject({
      nextRetryAt: base.now + 120_000,
    });
    expect(planMarketRetry({ ...base, attempt: 0, retryAfterMs: 1_200_000 })).toMatchObject({
      nextRetryAt: base.now + 900_000,
    });
    expect(planMarketRetry({ ...base, attempt: 0, retryAfterMs: 5_000 })).toMatchObject({
      nextRetryAt: base.now + 60_000,
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
