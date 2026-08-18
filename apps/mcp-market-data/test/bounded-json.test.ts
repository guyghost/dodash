import { describe, expect, it } from "vitest";

import {
  InvalidJsonError,
  PayloadTooLargeError,
  readBoundedJson,
} from "../src/bounded-json.js";

describe("readBoundedJson", () => {
  it("parses a bounded body", async () => {
    const response = new Response(JSON.stringify({ value: 42 }));
    await expect(readBoundedJson(response, 100)).resolves.toEqual({ value: 42 });
  });

  it("rejects a declared oversized body before parsing", async () => {
    const response = new Response("{}", {
      headers: { "content-length": "101" },
    });
    await expect(readBoundedJson(response, 100)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  it("rejects malformed JSON", async () => {
    await expect(readBoundedJson(new Response("{"), 100)).rejects.toBeInstanceOf(
      InvalidJsonError,
    );
  });
});
