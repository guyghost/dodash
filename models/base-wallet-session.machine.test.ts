import { createActor, type SnapshotFrom } from "xstate";
import { describe, expect, it } from "vitest";

import { baseWalletSessionMachine } from "./base-wallet-session.machine.js";
import {
  resolvePerpTradingCapability,
  BASE_PERP_ADMISSION,
} from "./base-perp-admission.js";
import { BASE_MAINNET_CHAIN_ID } from "./base-wallet-session.types.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER_ADDRESS = "0x2222222222222222222222222222222222222222";

type Actor = ReturnType<typeof createBaseWallet>;
const createBaseWallet = () =>
  createActor(baseWalletSessionMachine, { input: {} }).start();

const requestConnect = (actor: Actor, providerPresent = true) =>
  actor.send({ type: "CONNECT_REQUESTED", providerPresent });

const connectOnBase = (actor: Actor) => {
  requestConnect(actor);
  actor.send({
    type: "WALLET_CONNECTED",
    address: ADDRESS,
    chainId: BASE_MAINNET_CHAIN_ID,
  });
};

describe("baseWalletSessionMachine", () => {
  it("refuse une connexion sans provider injecté", () => {
    const actor = createBaseWallet();
    requestConnect(actor, false);
    expect(actor.getSnapshot().value).toBe("disconnected");
    expect(actor.getSnapshot().context.lastError?.code).toBe(
      "WALLET_PROVIDER_UNAVAILABLE",
    );
    expect(actor.getSnapshot().context.account).toBeNull();
  });

  it("connecte un wallet sur Base et expose le compte validé", () => {
    const actor = createBaseWallet();
    connectOnBase(actor);
    expect(actor.getSnapshot().value).toBe("connected");
    expect(actor.getSnapshot().context.account).toEqual({
      address: ADDRESS,
      chainId: BASE_MAINNET_CHAIN_ID,
    });
    expect(actor.getSnapshot().context.lastError).toBeNull();
  });

  it("route une connexion sur une autre chaîne vers wrongChain puis revient sur Base", () => {
    const actor = createBaseWallet();
    requestConnect(actor);
    actor.send({ type: "WALLET_CONNECTED", address: ADDRESS, chainId: 1 });
    expect(actor.getSnapshot().value).toBe("wrongChain");
    expect(actor.getSnapshot().context.account?.chainId).toBe(1);

    actor.send({ type: "WALLET_CHAIN_CHANGED", chainId: BASE_MAINNET_CHAIN_ID });
    expect(actor.getSnapshot().value).toBe("connected");
    expect(actor.getSnapshot().context.account).toEqual({
      address: ADDRESS,
      chainId: BASE_MAINNET_CHAIN_ID,
    });
  });

  it("envoie en failed tout payload invalide depuis le provider", () => {
    const actor = createBaseWallet();
    requestConnect(actor);
    actor.send({
      type: "WALLET_CONNECTED",
      address: "0xABCDEF",
      chainId: BASE_MAINNET_CHAIN_ID,
    });
    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.lastError?.code).toBe(
      "WALLET_INVALID_RESPONSE",
    );
    expect(actor.getSnapshot().context.account).toBeNull();
  });

  it("reste stable en failed et n'accepte qu'un retry explicite", () => {
    const actor = createBaseWallet();
    requestConnect(actor);
    actor.send({
      type: "WALLET_CONNECTED",
      address: "0xABCDEF",
      chainId: BASE_MAINNET_CHAIN_ID,
    });
    actor.send({ type: "WALLET_CHAIN_CHANGED", chainId: BASE_MAINNET_CHAIN_ID });
    expect(actor.getSnapshot().value).toBe("failed");

    requestConnect(actor);
    expect(actor.getSnapshot().value).toBe("connecting");
  });

  it("refuse le refus utilisateur comme erreur fermée et retryable", () => {
    const actor = createBaseWallet();
    requestConnect(actor);
    actor.send({
      type: "CONNECTION_FAILED",
      error: { code: "WALLET_REQUEST_REJECTED", retryable: true },
    });
    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.lastError?.retryable).toBe(true);
  });

  it("n'est pas réceptif à un second CONNECT_REQUESTED pendant connecting", () => {
    const actor = createBaseWallet();
    requestConnect(actor);
    requestConnect(actor);
    expect(actor.getSnapshot().value).toBe("connecting");
  });

  it("applique la rotation de compte et purge la session à la révocation", () => {
    const actor = createBaseWallet();
    connectOnBase(actor);

    actor.send({ type: "WALLET_ACCOUNT_CHANGED", address: OTHER_ADDRESS });
    expect(actor.getSnapshot().value).toBe("connected");
    expect(actor.getSnapshot().context.account?.address).toBe(OTHER_ADDRESS);

    actor.send({ type: "WALLET_ACCOUNT_CHANGED", address: null });
    expect(actor.getSnapshot().value).toBe("disconnected");
    expect(actor.getSnapshot().context.account).toBeNull();
  });

  it("bascule connected/wrongChain sur les changements de chaîne en session", () => {
    const actor = createBaseWallet();
    connectOnBase(actor);

    actor.send({ type: "WALLET_CHAIN_CHANGED", chainId: 84532 });
    expect(actor.getSnapshot().value).toBe("wrongChain");
    expect(actor.getSnapshot().context.account?.address).toBe(ADDRESS);

    actor.send({ type: "WALLET_CHAIN_CHANGED", chainId: BASE_MAINNET_CHAIN_ID });
    expect(actor.getSnapshot().value).toBe("connected");
  });

  it("traite une adresse de rotation invalide comme réponse provider invalide", () => {
    const actor = createBaseWallet();
    connectOnBase(actor);
    actor.send({
      type: "WALLET_ACCOUNT_CHANGED",
      address: "0xUPPERCASE1234567890ABCDEF1234567890AB",
    });
    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.account).toBeNull();
  });

  it("revient à disconnected depuis tout état via DISCONNECT_REQUESTED", () => {
    const actor = createBaseWallet();
    requestConnect(actor);
    actor.send({ type: "DISCONNECT_REQUESTED" });
    expect(actor.getSnapshot().value).toBe("disconnected");
    expect(actor.getSnapshot().context.providerPresent).toBe(false);

    connectOnBase(actor);
    actor.send({ type: "DISCONNECT_REQUESTED" });
    const snapshot: SnapshotFrom<typeof baseWalletSessionMachine> =
      actor.getSnapshot();
    expect(snapshot.value).toBe("disconnected");
    expect(snapshot.context.account).toBeNull();
    expect(snapshot.context.lastError).toBeNull();
  });

  it("garde la capacité perp verrouillée même connecté sur Base (admission fermée)", () => {
    const actor = createBaseWallet();
    connectOnBase(actor);
    expect(BASE_PERP_ADMISSION.status).toBe("CLOSED");

    const capability = resolvePerpTradingCapability(
      actor.getSnapshot().context.account,
    );
    expect(capability).toEqual({
      status: "LOCKED",
      reason: "ADMISSION_CLOSED",
    });
    expect(resolvePerpTradingCapability(null)).toEqual({
      status: "LOCKED",
      reason: "WALLET_NOT_CONNECTED",
    });
    expect(resolvePerpTradingCapability({ address: ADDRESS, chainId: 1 })).toEqual(
      { status: "LOCKED", reason: "WRONG_CHAIN" },
    );
  });
});
