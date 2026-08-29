import {
  type BaseWalletAccount,
  type BaseWalletError,
  isBaseWalletAddress,
} from "@dodash/models";

/**
 * Frontière impérative EIP-1193 du wallet Base. Ce module appartient au
 * shell navigateur : il est le seul à parler au provider ; la machine
 * `baseWalletSessionMachine` ne voit que des événements typés et validés.
 * Source de vérité : models/base-wallet-session.md.
 */

export interface Eip1193Provider {
  request(args: { readonly method: "eth_requestAccounts" }): Promise<unknown>;
  request(args: { readonly method: "eth_chainId" }): Promise<unknown>;
  on?(eventName: "accountsChanged", listener: (accounts: unknown) => void): void;
  on?(eventName: "chainChanged", listener: (chainId: unknown) => void): void;
  removeListener?(
    eventName: "accountsChanged",
    listener: (accounts: unknown) => void,
  ): void;
  removeListener?(
    eventName: "chainChanged",
    listener: (chainId: unknown) => void,
  ): void;
}

export class BaseWalletRequestError extends Error {
  readonly walletError: BaseWalletError;

  constructor(walletError: BaseWalletError) {
    super(walletError.code);
    this.name = "BaseWalletRequestError";
    this.walletError = walletError;
  }
}

const REQUEST_REJECTED: BaseWalletError = Object.freeze({
  code: "WALLET_REQUEST_REJECTED",
  retryable: true,
});
const INVALID_RESPONSE: BaseWalletError = Object.freeze({
  code: "WALLET_INVALID_RESPONSE",
  retryable: true,
});

const HEX_CHAIN_ID_PATTERN = /^0x[0-9a-f]+$/;

export const isEip1193Provider = (candidate: unknown): candidate is Eip1193Provider =>
  typeof candidate === "object" &&
  candidate !== null &&
  "request" in candidate &&
  typeof (candidate as { request?: unknown }).request === "function";

/** Provider injecté par l'app Base ou l'extension Base/Coinbase Wallet. */
export const findInjectedBaseWalletProvider = (): Eip1193Provider | null => {
  const candidate = (globalThis as { ethereum?: unknown }).ethereum;
  return isEip1193Provider(candidate) ? candidate : null;
};

export const parseHexChainId = (value: unknown): number | null => {
  if (typeof value !== "string" || !HEX_CHAIN_ID_PATTERN.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const toWalletError = (error: unknown): BaseWalletError => {
  if (error instanceof BaseWalletRequestError) return error.walletError;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4001 || code === "ACTION_REJECTED") return REQUEST_REJECTED;
  return INVALID_RESPONSE;
};

/**
 * Demande les comptes puis l'identité de chaîne, et ne retourne que le
 * couple validé (adresse canonique minuscules, chainId entier sûr). Toute
 * réponse inattendue devient une erreur typée, jamais un payload libre.
 */
export const connectBaseWallet = async (
  provider: Eip1193Provider,
): Promise<BaseWalletAccount> => {
  let rawAccounts: unknown;
  let rawChainId: unknown;
  try {
    rawAccounts = await provider.request({ method: "eth_requestAccounts" });
    rawChainId = await provider.request({ method: "eth_chainId" });
  } catch (error) {
    throw new BaseWalletRequestError(toWalletError(error));
  }
  const first = Array.isArray(rawAccounts) ? rawAccounts[0] : undefined;
  const address = typeof first === "string" ? first.trim().toLowerCase() : null;
  const chainId = parseHexChainId(rawChainId);
  if (address === null || !isBaseWalletAddress(address) || chainId === null) {
    throw new BaseWalletRequestError(INVALID_RESPONSE);
  }
  return Object.freeze({ address, chainId });
};

export interface BaseWalletSubscription {
  readonly onAccountsChanged: (accounts: unknown) => void;
  readonly onChainChanged: (chainId: unknown) => void;
}

/** Pose les souscriptions wallet ; retourne leur retrait, même si le provider ne supporte pas `on`. */
export const subscribeBaseWallet = (
  provider: Eip1193Provider,
  subscription: BaseWalletSubscription,
): (() => void) => {
  provider.on?.("accountsChanged", subscription.onAccountsChanged);
  provider.on?.("chainChanged", subscription.onChainChanged);
  return () => {
    provider.removeListener?.("accountsChanged", subscription.onAccountsChanged);
    provider.removeListener?.("chainChanged", subscription.onChainChanged);
  };
};
