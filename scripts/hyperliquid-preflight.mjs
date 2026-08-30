#!/usr/bin/env node
/**
 * Préflight live perp Hyperliquid : vérifie la méta réelle de la bourse
 * contre l'enveloppe figée HYPERLIQUID_PERP_2026_08 (models/
 * hyperliquid-execution.md, section préflight de models/hyperliquid-shell.md).
 *
 * Usage :
 *   node scripts/hyperliquid-preflight.mjs            # mainnet
 *   node scripts/hyperliquid-preflight.mjs --testnet  # testnet (répétition)
 *
 * Aucun secret : la lecture meta est publique. Exit 1 si un contrôle
 * échoue — l'activation live n'est pas autorisée tant que ce script ne
 * passe pas sur le réseau visé.
 */
import { fileURLToPath } from "node:url";

// Import direct du dist construit (pnpm --filter @dodash/models build).
const modelsUrl = new URL("../models/dist/index.js", import.meta.url);
let HYPERLIQUID_PERP_POLICY;
try {
  ({ HYPERLIQUID_PERP_POLICY } = await import(fileURLToPath(modelsUrl)));
} catch {
  console.error(
    "PREFLIGHT_FAIL: models/dist absent — lancer pnpm --filter @dodash/models build",
  );
  process.exit(1);
}

const isTestnet = process.argv.includes("--testnet");
const base = isTestnet
  ? "https://api.hyperliquid-testnet.xyz"
  : "https://api.hyperliquid.xyz";

// Miroir du mapping signal → coin de apps/agent/src/hyperliquid-execution.ts
const COINS = { "BTC-PERP": "BTC", "ETH-PERP": "ETH" };

const response = await fetch(`${base}/info`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "meta" }),
});
if (!response.ok) {
  console.error(`PREFLIGHT_FAIL: HTTP ${response.status} sur ${base}/info`);
  process.exit(1);
}
const meta = await response.json();
if (!Array.isArray(meta?.universe)) {
  console.error("PREFLIGHT_FAIL: réponse meta hors spec");
  process.exit(1);
}

let failures = 0;
for (const productId of HYPERLIQUID_PERP_POLICY.products) {
  const coin = COINS[productId];
  const asset = meta.universe.find((entry) => entry?.name === coin);
  if (asset === undefined) {
    console.error(`FAIL ${productId}: marché ${coin} absent de ${base}`);
    failures += 1;
    continue;
  }
  if (asset.szDecimals !== HYPERLIQUID_PERP_POLICY.sizeDecimals[productId]) {
    console.error(
      `FAIL ${productId}: szDecimals réel ${asset.szDecimals} ≠ enveloppe ${HYPERLIQUID_PERP_POLICY.sizeDecimals[productId]}`,
    );
    failures += 1;
    continue;
  }
  if (asset.maxLeverage < HYPERLIQUID_PERP_POLICY.maxLeverage) {
    console.error(
      `FAIL ${productId}: maxLeverage réel ${asset.maxLeverage} < enveloppe ${HYPERLIQUID_PERP_POLICY.maxLeverage}`,
    );
    failures += 1;
    continue;
  }
  console.log(
    `PASS ${productId} (${coin}) : szDecimals ${asset.szDecimals}, maxLeverage ${asset.maxLeverage}`,
  );
}

console.log(
  failures === 0
    ? `PREFLIGHT_PASS (${isTestnet ? "testnet" : "mainnet"}) : enveloppe HYPERLIQUID_PERP_2026_08 confirmée sur ${base}`
    : `PREFLIGHT_FAIL : ${failures} contrôle(s) en échec sur ${base}`,
);
process.exit(failures === 0 ? 0 : 1);
