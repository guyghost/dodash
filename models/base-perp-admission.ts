import {
  BASE_MAINNET_CHAIN_ID,
  type BaseWalletAccount,
} from "./base-wallet-session.types.js";

/**
 * Admission perp sur Base, figée fermée : la venue est tranchée
 * (Hyperliquid, routée par l'app Base) et modélisée
 * (models/hyperliquid-execution.md — enveloppe HYPERLIQUID_PERP_2026_08,
 * garde de risque, machine d'ordre). La fermeture ne tient plus qu'à des
 * livrables d'activation : câblage du shell Worker (clé d'agent, signature
 * EIP-712, REST), préflight des incréments, flag live dédié et éligibilité
 * géographique de l'opérateur. Source de vérité :
 * models/base-wallet-session.md et models/hyperliquid-execution.md.
 */
export interface BasePerpAdmission {
  readonly status: "CLOSED" | "OPEN";
  readonly reason:
    | "VENUE_NOT_MODELED"
    | "EXECUTION_NOT_WIRED"
    | "OPERATOR_NOT_CLEARED"
    | (string & {});
  readonly venue: string | null;
}

export const BASE_PERP_ADMISSION: BasePerpAdmission = Object.freeze({
  status: "CLOSED",
  reason: "EXECUTION_NOT_WIRED",
  venue: "HYPERLIQUID",
});

export type PerpTradingCapability =
  | {
      readonly status: "LOCKED";
      readonly reason:
        | "WALLET_NOT_CONNECTED"
        | "WRONG_CHAIN"
        | "ADMISSION_CLOSED";
    }
  | { readonly status: "APPROVED"; readonly venue: string };

/**
 * Dérive la capacité perp depuis la session wallet validée et l'admission
 * figée. Fonction pure : aucun état, aucune I/O. Tant que l'admission est
 * CLOSE, même une session connectée sur Base reste LOCKED.
 */
export const resolvePerpTradingCapability = (
  account: BaseWalletAccount | null,
): PerpTradingCapability => {
  if (account === null) {
    return Object.freeze({
      status: "LOCKED" as const,
      reason: "WALLET_NOT_CONNECTED" as const,
    });
  }
  if (account.chainId !== BASE_MAINNET_CHAIN_ID) {
    return Object.freeze({
      status: "LOCKED" as const,
      reason: "WRONG_CHAIN" as const,
    });
  }
  if (BASE_PERP_ADMISSION.status !== "OPEN" || BASE_PERP_ADMISSION.venue === null) {
    return Object.freeze({
      status: "LOCKED" as const,
      reason: "ADMISSION_CLOSED" as const,
    });
  }
  return Object.freeze({
    status: "APPROVED" as const,
    venue: BASE_PERP_ADMISSION.venue,
  });
};
