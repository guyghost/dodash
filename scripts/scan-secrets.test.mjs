import assert from "node:assert/strict";
import { test } from "node:test";

import { scanTrackedText } from "./scan-secrets.mjs";

test("detects a GitHub token in a tracked source", () => {
  const githubToken = "ghp_" + "abcdefghijklmnopqrstuvwxyz1234567890";
  const findings = scanTrackedText(
    "src/config.ts",
    `export const token = "${githubToken}";`,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "GITHUB_TOKEN");
});

test("detects a committed private key", () => {
  const privateKey =
    "-----BEGIN EC " +
    "PRIVATE KEY-----\nMHcCAQEEIFakesecretmaterial\n-----END EC PRIVATE KEY-----";
  const findings = scanTrackedText("secrets.env", privateKey);
  assert.equal(findings[0]?.kind, "PRIVATE_KEY");
});

test("detects a long secret assignment", () => {
  const findings = scanTrackedText(
    "config.env",
    "CONTROL_API_TOKEN=0123456789abcdefghijklmnopqrstuvwxyzABCD",
  );
  assert.equal(findings[0]?.kind, "SECRET_ASSIGNMENT");
});

test("accepts only the exact documented Coinbase placeholder block", () => {
  const placeholder = `COINBASE_API_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----
replace-with-the-exact-multiline-es256-private-key
-----END EC PRIVATE KEY-----"`;
  assert.deepEqual(scanTrackedText("apps/agent/.dev.vars.example", placeholder), []);

  const replaced = placeholder.replace(
    "replace-with-the-exact-multiline-es256-private-key",
    "MHcCAQEEIFakesecretmaterial",
  );
  assert.equal(scanTrackedText("apps/agent/.dev.vars", replaced)[0]?.kind, "PRIVATE_KEY");
});

test("reports line numbers without echoing the secret", () => {
  const secret = "sk_live_" + "abcdefghijklmnopqrstuvwxyz123456";
  const [finding] = scanTrackedText("billing.ts", `first\n${secret}\nlast`);
  assert.equal(finding?.line, 2);
  assert.equal(finding?.preview.includes(secret), false);
});
