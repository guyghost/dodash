import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("Tau Prolog runtime compatibility", () => {
  it("loads its CommonJS entry point inside a strict module wrapper", () => {
    const entryPath = require.resolve("tau-prolog");
    const source = readFileSync(entryPath, "utf8");
    const context = vm.createContext({
      console,
      exports: {},
      module: { exports: {} as unknown },
      window: {},
    });
    context.window = context;

    vm.runInContext(`"use strict";\n${source}`, context, {
      filename: entryPath,
    });

    expect(context.module.exports).toMatchObject({
      create: expect.any(Function),
    });
  });
});
