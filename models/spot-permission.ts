export type SpotPermission =
  | { readonly status: "EXECUTABLE" }
  | { readonly status: "INEXECUTABLE"; readonly reason: "SHORT_FORBIDDEN" };

export interface SpotPermissionError {
  readonly code: "INVALID_SPOT_PERMISSION_INPUT";
}

export type SpotPermissionResult =
  | { readonly ok: true; readonly value: SpotPermission }
  | { readonly ok: false; readonly error: SpotPermissionError };

/**
 * Miroir exact de la tolérance SPOT_SHORT_FORBIDDEN de checkRisk
 * (packages/risk/src/risk.ts). Tout drift doit être verrouillé par le
 * test d'équivalence sur grille dans packages/backtest.
 */
export const SPOT_QUANTITY_TOLERANCE = 1e-12;

/**
 * Décide si un ordre est exécutable en spot : un SELL dont la
 * quantité excède la position détenue (à la tolérance près) est
 * INEXECUTABLE — abandon intégral de l'ordre (DROP, jamais CLAMP).
 * Source de vérité : models/spot-prevalidation.md.
 */
export const resolveSpotPermission = (
  side: "BUY" | "SELL",
  quantity: number,
  positionQuantity: number,
): SpotPermissionResult => {
  if (
    (side !== "BUY" && side !== "SELL") ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(positionQuantity)
  ) {
    return {
      ok: false,
      error: Object.freeze({ code: "INVALID_SPOT_PERMISSION_INPUT" }),
    };
  }
  const signedQuantity = side === "BUY" ? quantity : -quantity;
  if (positionQuantity + signedQuantity < -SPOT_QUANTITY_TOLERANCE) {
    return Object.freeze({
      ok: true as const,
      value: Object.freeze({
        status: "INEXECUTABLE" as const,
        reason: "SHORT_FORBIDDEN" as const,
      }),
    });
  }
  return Object.freeze({ ok: true as const, value: Object.freeze({ status: "EXECUTABLE" as const }) });
};
