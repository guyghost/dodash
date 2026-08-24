import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);

test("release_sha is never interpolated directly into a shell script", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const lines = workflow.split("\n");
  const shellLines = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const run = line.match(/^(\s*)run:\s*(.*)$/);
    if (run === null) continue;
    shellLines.push(run[2] ?? "");
    if ((run[2] ?? "").trim() !== "|") continue;
    const runIndent = run[1]?.length ?? 0;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const scriptLine = lines[cursor] ?? "";
      const contentIndent = scriptLine.match(/^\s*/)?.[0].length ?? 0;
      if (scriptLine.trim().length > 0 && contentIndent <= runIndent) break;
      shellLines.push(scriptLine);
      index = cursor;
    }
  }

  assert.doesNotMatch(shellLines.join("\n"), /\$\{\{\s*inputs\.release_sha\s*\}\}/);
  assert.match(
    workflow,
    /RELEASE_SHA:\s*\$\{\{\s*inputs\.release_sha\s*\}\}/,
  );
});
