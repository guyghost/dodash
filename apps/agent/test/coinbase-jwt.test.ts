import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createCoinbaseJwt } from "../src/coinbase-jwt.js";

const decodePart = (part: string | undefined): Record<string, unknown> => {
  if (part === undefined) throw new Error("missing JWT part");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
};

describe("createCoinbaseJwt", () => {
  it("creates a request-bound ES256 JWT with a two-minute lifetime", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const apiKeyId = "organizations/org/apiKeys/key";
    const jwt = createCoinbaseJwt({
      apiKeyId,
      privateKeyPem: privateKey.export({ type: "sec1", format: "pem" }).toString(),
      method: "POST",
      host: "api.coinbase.com",
      path: "/api/v3/brokerage/orders",
      nowSeconds: 1_700_000_000,
      nonce: "0123456789abcdef0123456789abcdef",
    });

    const [headerPart, payloadPart, signaturePart] = jwt.token.split(".");
    expect(decodePart(headerPart)).toEqual({
      alg: "ES256",
      typ: "JWT",
      kid: apiKeyId,
      nonce: "0123456789abcdef0123456789abcdef",
    });
    expect(decodePart(payloadPart)).toEqual({
      sub: apiKeyId,
      iss: "cdp",
      nbf: 1_700_000_000,
      exp: 1_700_000_120,
      uri: "POST api.coinbase.com/api/v3/brokerage/orders",
    });
    expect(jwt).toMatchObject({
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_120_000,
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${headerPart}.${payloadPart}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signaturePart ?? "", "base64url"),
      ),
    ).toBe(true);
  });

  it("rejects a non-P-256 key", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    expect(() =>
      createCoinbaseJwt({
        apiKeyId: "organizations/org/apiKeys/key",
        privateKeyPem: privateKey.export({ type: "sec1", format: "pem" }).toString(),
        method: "GET",
        host: "api.coinbase.com",
        path: "/api/v3/brokerage/orders",
        nonce: "0123456789abcdef",
      }),
    ).toThrow("COINBASE_KEY_MUST_BE_ES256");
  });
});
