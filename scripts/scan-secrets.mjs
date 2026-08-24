import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DOCUMENTED_PLACEHOLDER_BLOCKS = Object.freeze([
  `COINBASE_API_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----
replace-with-the-exact-multiline-es256-private-key
-----END EC PRIVATE KEY-----"`,
  `COINBASE_API_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----
<clé ES256 multiligne exacte>
-----END EC PRIVATE KEY-----"`,
]);

const PATTERNS = Object.freeze([
  {
    kind: "PRIVATE_KEY",
    expression: /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/gu,
  },
  {
    kind: "GITHUB_TOKEN",
    expression: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  },
  {
    kind: "STRIPE_LIVE_SECRET",
    expression: /\bsk_live_[A-Za-z0-9]{16,}\b/gu,
  },
  {
    kind: "AWS_ACCESS_KEY",
    expression: /\bAKIA[0-9A-Z]{16}\b/gu,
  },
  {
    kind: "SECRET_ASSIGNMENT",
    expression:
      /(?:^|\n)\s*([A-Z0-9_]*(?:TOKEN|SECRET|PRIVATE_KEY|PASSWORD|API_KEY)[A-Z0-9_]*)\s*=\s*["']?([A-Za-z0-9+/_=.-]{24,})/gmu,
    nameGroup: 1,
    valueGroup: 2,
  },
]);

const lineAt = (text, index) =>
  text.slice(0, index).split("\n").length;

const maskPlaceholder = (block) => block.replace(/[^\n]/gu, " ");

const withoutDocumentedPlaceholders = (text) =>
  DOCUMENTED_PLACEHOLDER_BLOCKS.reduce(
    (current, block) => current.replaceAll(block, maskPlaceholder(block)),
    text,
  );

const placeholderValue = (value) =>
  value.startsWith("replace-with-") ||
  value.startsWith("example-") ||
  value.startsWith("placeholder-");

export const scanTrackedText = (path, source) => {
  if (typeof path !== "string" || path.length === 0 || typeof source !== "string") {
    throw new TypeError("INVALID_SECRET_SCAN_INPUT");
  }
  const text = withoutDocumentedPlaceholders(source);
  const findings = [];
  for (const pattern of PATTERNS) {
    pattern.expression.lastIndex = 0;
    for (const match of text.matchAll(pattern.expression)) {
      const matchedValue = pattern.valueGroup === undefined
        ? match[0]
        : match[pattern.valueGroup];
      const assignmentName = pattern.nameGroup === undefined
        ? null
        : match[pattern.nameGroup];
      if (
        matchedValue === undefined ||
        placeholderValue(matchedValue) ||
        assignmentName?.endsWith("_ID")
      ) continue;
      const offsetInMatch = match[0].indexOf(matchedValue);
      const index = (match.index ?? 0) + Math.max(0, offsetInMatch);
      findings.push(Object.freeze({
        path,
        line: lineAt(text, index),
        kind: pattern.kind,
        preview: `[REDACTED ${pattern.kind}]`,
      }));
    }
  }
  return Object.freeze(findings);
};

const trackedFiles = () => {
  const raw = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return raw.split("\0").filter((path) => path.length > 0);
};

export const scanTrackedFiles = () => {
  const findings = [];
  for (const path of trackedFiles()) {
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    findings.push(...scanTrackedText(path, bytes.toString("utf8")));
  }
  return Object.freeze(findings);
};

const run = () => {
  try {
    const findings = scanTrackedFiles();
    if (findings.length === 0) {
      process.stdout.write("Secret scan passed: no tracked secret patterns found.\n");
      return;
    }
    for (const finding of findings) {
      process.stderr.write(
        `${finding.path}:${finding.line} ${finding.kind} ${finding.preview}\n`,
      );
    }
    process.exitCode = 1;
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    process.stderr.write(`Secret scan failed closed: ${name}\n`);
    process.exitCode = 2;
  }
};

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  run();
}
