import { describe, expect, it } from "vitest";

import {
  resolveSpotPermission,
  SPOT_QUANTITY_TOLERANCE,
} from "./spot-permission.js";

describe("resolveSpotPermission", () => {
  it("autorise tout BUY spot (pas de plafond long)", () => {
    const permission = resolveSpotPermission("BUY", 10, 0);
    expect(permission).toEqual({
      ok: true,
      value: { status: "EXECUTABLE" },
    });
  });

  it("interdit un SELL à plat (cas dominant mesuré)", () => {
    const permission = resolveSpotPermission("SELL", 0.5, 0);
    expect(permission).toEqual({
      ok: true,
      value: { status: "INEXECUTABLE", reason: "SHORT_FORBIDDEN" },
    });
  });

  it("interdit un SELL dépassant partiellement la position (DROP, pas CLAMP)", () => {
    const permission = resolveSpotPermission("SELL", 1, 0.3);
    expect(permission).toEqual({
      ok: true,
      value: { status: "INEXECUTABLE", reason: "SHORT_FORBIDDEN" },
    });
  });

  it("autorise un SELL couvert exactement par la position", () => {
    const permission = resolveSpotPermission("SELL", 1, 1);
    expect(permission).toEqual({
      ok: true,
      value: { status: "EXECUTABLE" },
    });
  });

  it("applique la tolérance flottante partagée avec checkRisk", () => {
    // projected = -tolerance/2 → dans la bande, exécutable.
    const permission = resolveSpotPermission(
      "SELL",
      1,
      1 - SPOT_QUANTITY_TOLERANCE / 2,
    );
    expect(permission).toEqual({
      ok: true,
      value: { status: "EXECUTABLE" },
    });
    // projected = -2·tolerance → hors bande, inexécutable.
    const denied = resolveSpotPermission(
      "SELL",
      1,
      1 - 2 * SPOT_QUANTITY_TOLERANCE,
    );
    expect(denied).toEqual({
      ok: true,
      value: { status: "INEXECUTABLE", reason: "SHORT_FORBIDDEN" },
    });
  });

  it.each([
    ["quantité nulle", "SELL", 0, 1] as const,
    ["quantité négative", "SELL", -1, 1] as const,
    ["quantité NaN", "SELL", Number.NaN, 1] as const,
    ["quantité infinie", "BUY", Number.POSITIVE_INFINITY, 1] as const,
    ["position NaN", "BUY", 1, Number.NaN] as const,
    ["position infinie", "SELL", 1, Number.POSITIVE_INFINITY] as const,
  ])("refuse une entrée invalide (%s)", (_label, side, quantity, position) => {
    expect(resolveSpotPermission(side, quantity, position)).toEqual({
      ok: false,
      error: { code: "INVALID_SPOT_PERMISSION_INPUT" },
    });
  });
});
