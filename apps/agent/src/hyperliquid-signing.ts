import { encode } from "@msgpack/msgpack";
import {
  getBytes,
  keccak256,
  type Signer,
  Signature,
  toUtf8Bytes,
} from "ethers";

/**
 * Réplication du schéma de signature L1 Hyperliquid (SDK de référence
 * v1.7.7, src/utils/signing.ts) : hash d'action msgpack + nonce + coffret,
 * puis EIP-712 sur le domaine fantôme Exchange/1/1337 avec le type Agent.
 * Seuls @msgpack/msgpack et ethers, purs, entrent dans le bundle Worker :
 * le SDK racine importe des modules `ws` et reste un devDependency utilisé
 * par le test d'équivalence. Source de vérité :
 * models/hyperliquid-shell.md.
 */

const PHANTOM_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
};

export interface HyperliquidSignature {
  readonly r: string;
  readonly s: string;
  readonly v: number;
}

/** Action d'ordre avec clés insérées dans l'ordre exact attendu par le hash msgpack. */
export interface HyperliquidOrderAction {
  readonly type: "order";
  readonly orders: ReadonlyArray<{
    readonly a: number;
    readonly b: boolean;
    readonly p: string;
    readonly s: string;
    readonly r: boolean;
    readonly t: { readonly limit: { readonly tif: "Ioc" | "Gtc" | "Alo" } };
    readonly c?: string;
  }>;
  readonly grouping: "na";
}

export const hyperliquidActionHash = (
  action: unknown,
  vaultAddress: string | null,
  nonce: number,
): string => {
  const msgPackBytes = encode(action);
  const additionalBytesLength = vaultAddress === null ? 9 : 29;
  const data = new Uint8Array(msgPackBytes.length + additionalBytesLength);
  data.set(msgPackBytes);
  const view = new DataView(data.buffer);
  view.setBigUint64(msgPackBytes.length, BigInt(nonce), false);
  if (vaultAddress === null) {
    view.setUint8(msgPackBytes.length + 8, 0);
  } else {
    view.setUint8(msgPackBytes.length + 8, 1);
    data.set(getBytes(vaultAddress), msgPackBytes.length + 9);
  }
  return keccak256(data);
};

export const signHyperliquidL1Action = async (
  signer: Signer,
  action: unknown,
  nonce: number,
  isMainnet = true,
): Promise<HyperliquidSignature> => {
  const hash = hyperliquidActionHash(action, null, nonce);
  const signature = await signer.signTypedData(PHANTOM_DOMAIN, AGENT_TYPES, {
    source: isMainnet ? "a" : "b",
    connectionId: hash,
  });
  const split = Signature.from(signature);
  return Object.freeze({ r: split.r, s: split.s, v: split.v });
};

/** `cloid` déterministe : keccak256 du clientOrderId tronqué à 32 octets. */
export const hyperliquidCloidFromClientOrderId = (
  clientOrderId: string,
): string => keccak256(toUtf8Bytes(clientOrderId)).slice(0, 34);
