import { assign, setup } from "xstate";

import {
  BASE_MAINNET_CHAIN_ID,
  BASE_WALLET_ADDRESS_PATTERN,
  type BaseWalletSessionContext,
  type BaseWalletSessionEvent,
  type BaseWalletSessionInput,
} from "./base-wallet-session.types.js";

const isValidAddress = (address: string): boolean =>
  BASE_WALLET_ADDRESS_PATTERN.test(address);

const isValidChainId = (chainId: number): boolean =>
  Number.isSafeInteger(chainId) && chainId > 0;

const isValidAccountPayload = (event: BaseWalletSessionEvent): boolean =>
  event.type === "WALLET_CONNECTED" &&
  isValidAddress(event.address) &&
  isValidChainId(event.chainId);

export const isBaseWalletAddress = isValidAddress;

export const baseWalletSessionMachine = setup({
  types: {
    context: {} as BaseWalletSessionContext,
    events: {} as BaseWalletSessionEvent,
    input: {} as BaseWalletSessionInput,
  },
  guards: {
    providerPresent: ({ event }) =>
      event.type === "CONNECT_REQUESTED" && event.providerPresent,
    validAccountPayload: ({ event }) => isValidAccountPayload(event),
    validBaseAccountPayload: ({ event }) =>
      event.type === "WALLET_CONNECTED" &&
      isValidAddress(event.address) &&
      event.chainId === BASE_MAINNET_CHAIN_ID,
    baseChain: ({ event }) =>
      event.type === "WALLET_CHAIN_CHANGED" &&
      isValidChainId(event.chainId) &&
      event.chainId === BASE_MAINNET_CHAIN_ID,
    validChainId: ({ event }) =>
      event.type === "WALLET_CHAIN_CHANGED" && isValidChainId(event.chainId),
    revocation: ({ event }) =>
      event.type === "WALLET_ACCOUNT_CHANGED" && event.address === null,
    validRotatedAddress: ({ event }) =>
      event.type === "WALLET_ACCOUNT_CHANGED" &&
      event.address !== null &&
      isValidAddress(event.address),
  },
  actions: {
    recordProvider: assign({
      providerPresent: true,
      lastError: null,
    }),
    recordProviderUnavailable: assign({
      providerPresent: false,
      lastError: {
        code: "WALLET_PROVIDER_UNAVAILABLE",
        retryable: true,
      } as const,
    }),
    recordAccount: assign(({ event }) =>
      event.type === "WALLET_CONNECTED"
        ? {
            account: Object.freeze({ address: event.address, chainId: event.chainId }),
            lastError: null,
          }
        : {},
    ),
    rotateAccount: assign(({ context, event }) =>
      event.type === "WALLET_ACCOUNT_CHANGED" &&
      event.address !== null &&
      context.account !== null
        ? {
            account: Object.freeze({
              address: event.address,
              chainId: context.account.chainId,
            }),
            lastError: null,
          }
        : {},
    ),
    recordChain: assign(({ context, event }) =>
      event.type === "WALLET_CHAIN_CHANGED" && context.account !== null
        ? {
            account: Object.freeze({
              address: context.account.address,
              chainId: event.chainId,
            }),
            lastError: null,
          }
        : {},
    ),
    recordConnectionError: assign(({ event }) =>
      event.type === "CONNECTION_FAILED"
        ? { lastError: event.error }
        : {},
    ),
    recordInvalidPayload: assign({
      account: null,
      lastError: {
        code: "WALLET_INVALID_RESPONSE",
        retryable: true,
      } as const,
    }),
    clearSession: assign({
      providerPresent: false,
      account: null,
      lastError: null,
    }),
  },
}).createMachine({
  id: "baseWalletSession",
  context: ({ input }) => ({
    providerPresent: input.providerPresent ?? false,
    account: null,
    lastError: null,
  }),
  initial: "disconnected",
  on: {
    DISCONNECT_REQUESTED: { target: ".disconnected", actions: "clearSession" },
  },
  states: {
    disconnected: {
      on: {
        CONNECT_REQUESTED: [
          {
            guard: "providerPresent",
            target: "connecting",
            actions: "recordProvider",
          },
          { actions: "recordProviderUnavailable" },
        ],
      },
    },
    connecting: {
      on: {
        WALLET_CONNECTED: [
          {
            guard: "validBaseAccountPayload",
            target: "connected",
            actions: "recordAccount",
          },
          {
            guard: "validAccountPayload",
            target: "wrongChain",
            actions: "recordAccount",
          },
          { target: "failed", actions: "recordInvalidPayload" },
        ],
        CONNECTION_FAILED: { target: "failed", actions: "recordConnectionError" },
      },
    },
    connected: {
      on: {
        WALLET_ACCOUNT_CHANGED: [
          { guard: "revocation", target: "disconnected", actions: "clearSession" },
          {
            guard: "validRotatedAddress",
            target: "connected",
            actions: "rotateAccount",
          },
          { target: "failed", actions: "recordInvalidPayload" },
        ],
        WALLET_CHAIN_CHANGED: [
          {
            guard: "baseChain",
            target: "connected",
            actions: "recordChain",
          },
          {
            guard: "validChainId",
            target: "wrongChain",
            actions: "recordChain",
          },
          { target: "failed", actions: "recordInvalidPayload" },
        ],
        CONNECTION_FAILED: { target: "failed", actions: "recordConnectionError" },
      },
    },
    wrongChain: {
      on: {
        WALLET_CHAIN_CHANGED: [
          { guard: "baseChain", target: "connected", actions: "recordChain" },
          {
            guard: "validChainId",
            target: "wrongChain",
            actions: "recordChain",
          },
          { target: "failed", actions: "recordInvalidPayload" },
        ],
        WALLET_ACCOUNT_CHANGED: [
          { guard: "revocation", target: "disconnected", actions: "clearSession" },
          {
            guard: "validRotatedAddress",
            target: "wrongChain",
            actions: "rotateAccount",
          },
          { target: "failed", actions: "recordInvalidPayload" },
        ],
        CONNECTION_FAILED: { target: "failed", actions: "recordConnectionError" },
      },
    },
    failed: {
      on: {
        CONNECT_REQUESTED: [
          {
            guard: "providerPresent",
            target: "connecting",
            actions: "recordProvider",
          },
          { actions: "recordProviderUnavailable" },
        ],
      },
    },
  },
});
