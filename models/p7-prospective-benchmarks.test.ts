import { describe, expect, it } from "vitest";
import { sizeP7BenchmarkBuy, registerP7BenchmarkProfile } from "./p7-prospective-benchmarks.js";
const start = Date.UTC(2026, 9, 16);
const manifest = { campaignId: "fixture", sourceProfileId: "fixture", startAt: start };
const command = { campaignId: "fixture", commandId: "benchmark-profile", event: { type: "REGISTER_BENCHMARK_PROFILE",
  sourceProfileId: "fixture", profileSha256: "a".repeat(64), quantityDecimals: { "BTC-USD": 2, "ETH-USD": 3 } } };
const book = { bids: [{ price: 99, quantity: 200 }], asks: [{ price: 100, quantity: 10 }, { price: 101, quantity: 200 }] };
describe("P7 funded B&H quantity", () => {
  it("finds the maximal funded lot across asks and keeps costs single", () => {
    const result = sizeP7BenchmarkBuy(book, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cost = (q: number) => (100 * Math.min(q, 10) + 101 * Math.max(0, q - 10)) * 1.0002 * 1.006;
    expect(cost(result.quantity)).toBeLessThanOrEqual(10_000);
    expect(cost(result.quantity + 0.01)).toBeGreaterThan(10_000);
    expect(result.quantity).toBeCloseTo(result.units / 100, 10);
  });
  it("does not buy all displayed depth merely because cash remains", () => {
    expect(sizeP7BenchmarkBuy({ ...book, asks: [{ price: 100, quantity: 1 }] }, 2)).toEqual({ ok: false, reason: "INSUFFICIENT_DEPTH" });
  });
  it("accepts missing depth only when even the next rounded lot cannot be funded", () => {
    // Budget cannot buy 100 units at 100 including costs; 99 units fit.
    const result = sizeP7BenchmarkBuy({ ...book, asks: [{ price: 100, quantity: 99.4 }] }, 0);
    expect(result).toMatchObject({ ok: true, quantity: 99, units: 99 });
  });
  it("rejects zero funded lots, unsafe precision and invalid books", () => {
    expect(sizeP7BenchmarkBuy({ ...book, asks: [{ price: 20_000, quantity: 200 }] }, 0).ok).toBe(false);
    for (const decimals of [-1, 13, 1.5, NaN]) expect(sizeP7BenchmarkBuy(book, decimals).ok).toBe(false);
    expect(sizeP7BenchmarkBuy({ ...book, asks: [{ price: 1, quantity: Number.MAX_VALUE }] }, 12).ok).toBe(false);
    expect(sizeP7BenchmarkBuy({ bids: [], asks: [] }, 2).ok).toBe(false);
  });
  it("registers a closed precision profile only before T0 and never overwrites it", () => {
    const result = registerP7BenchmarkProfile(null, manifest, command, start - 1);
    expect(result.ok).toBe(true);
    expect(registerP7BenchmarkProfile(null, manifest, command, start).ok).toBe(false);
    if (!result.ok) return;
    expect(registerP7BenchmarkProfile(result.value, manifest, command, start - 1).ok).toBe(false);
    expect(registerP7BenchmarkProfile(null, manifest, { ...command, price: 1 }, start - 1).ok).toBe(false);
    expect(registerP7BenchmarkProfile(null, manifest, { ...command, event: { ...command.event, sourceProfileId: "other" } }, start - 1).ok).toBe(false);
  });
  it("never exceeds budget or leaves an affordable known lot for several precisions", () => {
    for (const precision of [0, 1, 2, 6, 12]) {
      const result = sizeP7BenchmarkBuy(book, precision);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.cost).toBeLessThanOrEqual(10_000);
      const next = result.quantity + 10 ** -precision;
      const cost = (1_000 + (next - 10) * 101) * 1.0002 * 1.006;
      expect(cost).toBeGreaterThan(10_000);
    }
  });
});
