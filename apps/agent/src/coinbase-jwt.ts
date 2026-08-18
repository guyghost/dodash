import {
  createPrivateKey,
  randomBytes,
  sign as signBytes,
} from "node:crypto";

export type CoinbaseHttpMethod = "GET" | "POST";

export interface CoinbaseJwtRequest {
  readonly apiKeyId: string;
  readonly privateKeyPem: string;
  readonly method: CoinbaseHttpMethod;
  readonly host: string;
  readonly path: string;
  readonly nowSeconds?: number;
  readonly nonce?: string;
}

export interface CoinbaseJwt {
  readonly token: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

const JWT_TTL_SECONDS = 120;
const SUPPORTED_CURVES = new Set(["P-256", "prime256v1", "secp256r1"]);

const base64Url = (value: string | Uint8Array): string =>
  Buffer.from(value).toString("base64url");

const validateRequest = (request: CoinbaseJwtRequest): void => {
  if (
    request.apiKeyId.trim().length === 0 ||
    request.privateKeyPem.trim().length === 0 ||
    request.host.trim().length === 0 ||
    !request.path.startsWith("/") ||
    request.path.includes("?") ||
    request.path.includes("#")
  ) {
    throw new Error("INVALID_COINBASE_JWT_INPUT");
  }
};

export const createCoinbaseJwt = (
  request: CoinbaseJwtRequest,
): CoinbaseJwt => {
  validateRequest(request);
  const nowSeconds = request.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error("INVALID_COINBASE_JWT_TIME");
  }

  const key = createPrivateKey(request.privateKeyPem);
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (
    key.asymmetricKeyType !== "ec" ||
    curve === undefined ||
    !SUPPORTED_CURVES.has(curve)
  ) {
    throw new Error("COINBASE_KEY_MUST_BE_ES256");
  }

  const nonce = request.nonce ?? Buffer.from(randomBytes(16)).toString("hex");
  if (nonce.length < 16) throw new Error("INVALID_COINBASE_JWT_NONCE");

  const header = base64Url(
    JSON.stringify({
      alg: "ES256",
      typ: "JWT",
      kid: request.apiKeyId,
      nonce,
    }),
  );
  const payload = base64Url(
    JSON.stringify({
      sub: request.apiKeyId,
      iss: "cdp",
      nbf: nowSeconds,
      exp: nowSeconds + JWT_TTL_SECONDS,
      uri: `${request.method} ${request.host}${request.path}`,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = signBytes("sha256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  if (signature.byteLength !== 64) {
    throw new Error("INVALID_ES256_SIGNATURE");
  }

  return Object.freeze({
    token: `${signingInput}.${base64Url(signature)}`,
    issuedAt: nowSeconds * 1_000,
    expiresAt: (nowSeconds + JWT_TTL_SECONDS) * 1_000,
  });
};
