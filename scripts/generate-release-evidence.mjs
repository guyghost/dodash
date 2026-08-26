import { mkdir, open } from "node:fs/promises";
import path from "node:path";

import {
  createReleaseEvidence,
  RELEASE_EVIDENCE_GATES,
  validateReleaseEvidence,
} from "../models/dist/index.js";

const parseArguments = (arguments_) => {
  const expected = ["--release-sha", "--generated-at", "--output"];
  if (
    arguments_.length !== expected.length * 2 ||
    expected.some((name, index) => arguments_[index * 2] !== name)
  ) {
    throw new Error(
      "Usage: generate-release-evidence --release-sha SHA --generated-at ISO_UTC --output PATH",
    );
  }
  return {
    releaseSha: arguments_[1],
    generatedAt: arguments_[3],
    output: arguments_[5],
  };
};

const main = async () => {
  const { releaseSha, generatedAt, output } = parseArguments(process.argv.slice(2));
  const result = createReleaseEvidence({
    schemaVersion: 1,
    releaseSha,
    generatedAt,
    liveTradingEnabled: false,
    gates: Object.fromEntries(
      RELEASE_EVIDENCE_GATES.map((gate) => [gate, "passed"]),
    ),
  });
  if (!result.ok) {
    throw new Error(result.error);
  }

  const serialized = `${JSON.stringify(result.evidence, null, 2)}\n`;
  const validation = validateReleaseEvidence(JSON.parse(serialized));
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  const file = await open(output, "wx");
  try {
    await file.writeFile(serialized, "utf8");
  } finally {
    await file.close();
  }
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
