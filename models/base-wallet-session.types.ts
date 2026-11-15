export const BASE_MAINNET_CHAIN_ID = 8453;

export const BASE_WALLET_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

export type BaseWalletErrorCode =
  | "WALLET_PROVIDER_UNAVAILABLE"
  | "WALLET_REQUEST_REJECTED"
  | "WALLET_INVALID_RESPONSE";

export interface BaseWalletError {
  readonly code: BaseWalletErrorCode;
  readonly retryable: boolean;
}

export interface BaseWalletAccount {
  readonly address: string;
  readonly chainId: number;
}

export interface BaseWalletSessionContext {
  readonly providerPresent: boolean;
  readonly account: BaseWalletAccount | null;
  readonly lastError: BaseWalletError | null;
}

export type BaseWalletSessionEvent =
  | { readonly type: "CONNECT_REQUESTED"; readonly providerPresent: boolean }
  | {
      readonly type: "WALLET_CONNECTED";
      readonly address: string;
      readonly chainId: number;
    }
  | { readonly type: "CONNECTION_FAILED"; readonly error: BaseWalletError }
  | { readonly type: "WALLET_ACCOUNT_CHANGED"; readonly address: string | null }
  | { readonly type: "WALLET_CHAIN_CHANGED"; readonly chainId: number }
  | { readonly type: "DISCONNECT_REQUESTED" };

export interface BaseWalletSessionInput {
  readonly providerPresent?: boolean;
}
