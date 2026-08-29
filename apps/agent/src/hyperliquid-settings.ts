import { err, ok, type Result } from "@dodash/domain";

/**
 * Réglages du shell Hyperliquid. Source de vérité :
 * models/hyperliquid-shell.md. Tout réglage incomplet invalide la chaîne
 * live perp entière : aucun demi-réglage ne peut signer.
 */

export const HYPERLIQUID_PRODUCTION_URL = "https://api.hyperliquid.xyz";
export const HYPERLIQUID_TESTNET_URL = "https://api.hyperliquid-testnet.xyz";

export interface HyperliquidSettingsInput {
  readonly HYPERLIQUID_PERP_TRADING_ENABLED?: string;
  readonly HYPERLIQUID_AGENT_PRIVATE_KEY?: string;
  readonly HYPERLIQUID_WALLET_ADDRESS?: string;
  readonly HYPERLIQUID_TESTNET?: string;
  readonly HYPERLIQUID_API_BASE_URL?: string;
}

export interface HyperliquidExecutionSettings {
  readonly apiBaseUrl: string;
  readonly agentPrivateKey: string;
  readonly walletAddress: string;
  readonly isTestnet: boolean;
}

export type HyperliquidSettingsError = {
  readonly code: "HYPERLIQUID_EXECUTION_UNAVAILABLE";
};

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const resolveApiBaseUrl = (
  declared: string | undefined,
  isTestnet: boolean,
): Result<string, HyperliquidSettingsError> => {
  const candidate = declared?.trim() || (isTestnet ? HYPERLIQUID_TESTNET_URL : HYPERLIQUID_PRODUCTION_URL);
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return err({ code: "HYPERLIQUID_EXECUTION_UNAVAILABLE" });
    }
    return ok(url.origin);
  } catch {
    return err({ code: "HYPERLIQUID_EXECUTION_UNAVAILABLE" });
  }
};

export const resolveHyperliquidSettings = (
  input: HyperliquidSettingsInput,
): Result<HyperliquidExecutionSettings, HyperliquidSettingsError> => {
  if (input.HYPERLIQUID_PERP_TRADING_ENABLED !== "true") {
    return err({ code: "HYPERLIQUID_EXECUTION_UNAVAILABLE" });
  }
  const agentPrivateKey = input.HYPERLIQUID_AGENT_PRIVATE_KEY?.trim() ?? "";
  const walletAddress = input.HYPERLIQUID_WALLET_ADDRESS?.trim() ?? "";
  if (
    !PRIVATE_KEY_PATTERN.test(agentPrivateKey) ||
    !ADDRESS_PATTERN.test(walletAddress)
  ) {
    return err({ code: "HYPERLIQUID_EXECUTION_UNAVAILABLE" });
  }
  const isTestnet = input.HYPERLIQUID_TESTNET === "true";
  const base = resolveApiBaseUrl(input.HYPERLIQUID_API_BASE_URL, isTestnet);
  if (!base.ok) return base;
  return ok(
    Object.freeze({
      apiBaseUrl: base.value,
      agentPrivateKey,
      walletAddress,
      isTestnet,
    }),
  );
};
