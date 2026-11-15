import { describe, expect, it } from "vitest";
import { initializeP7Ledger } from "./p7-prospective-ledger.js";
import { emptyP7BenchmarkEntries, applyP7BenchmarkEntry, recoverP7BenchmarkEntry } from "./p7-prospective-benchmark-entry.js";
const start = Date.UTC(2026, 9, 16);
const manifest = { purpose: "LOCAL_PREPARATION" as const, campaignId: "entry-fixture", manifestSha256: "a".repeat(64),
  startAt: start, endAt: start + 180 * 86_400_000, sourceProfileId: "fixture", clockVerified: true };
const init = initializeP7Ledger(manifest, start - 2);
if (!init.ok) throw new Error(init.error);
const ledger = init.value, profile = { sourceProfileId: "fixture", profileSha256: "b".repeat(64), quantityDecimals: { "BTC-USD": 2, "ETH-USD": 2 } };
const book = { productId: "BTC-USD", sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: "1",
  requestedAt: start, receivedAt: start + 1, sourceObservedAt: start + 1, bids: [{ price: 99, quantity: 200 }], asks: [{ price: 101, quantity: 200 }] };
const command = (type: string, override = {}) => ({ campaignId: manifest.campaignId, commandId: type, productId: "BTC-USD",
  event: type === "OBSERVE_BENCHMARK_BOOK" ? { type, book, bodySha256: "c".repeat(64), ...override } : { type, ...override } });
const next = (state: ReturnType<typeof emptyP7BenchmarkEntries>, type: string, at = start, override = {}) => {
  const result = applyP7BenchmarkEntry(state, ledger, profile, "localObserving", command(type, override), at);
  if (!result.ok) throw new Error(result.error);
  return result.value.state;
};
const requested = () => next(next(emptyP7BenchmarkEntries(), "EXPECT_BENCHMARK"), "REQUEST_BENCHMARK");
const quoted = () => next(requested(), "OBSERVE_BENCHMARK_BOOK", start + 1);
describe("independent synthetic B&H entry", () => {
  it("initializes without a P7 decision and never changes its portfolio", () => {
    const result = next(quoted(), "RESOLVE_BENCHMARK", start + 2);
    expect(result.products["BTC-USD"]?.phase).toBe("initialized");
    expect(result.products["BTC-USD"]?.portfolio?.cash).toBeGreaterThanOrEqual(0);
    expect(ledger.slots).toEqual({});
    expect(ledger.portfolios["BTC-USD"].positionQuantity).toBe(0);
  });
  it("freezes the first eligible book and cannot request another one", () => {
    expect(applyP7BenchmarkEntry(quoted(), ledger, profile, "localObserving", command("REQUEST_BENCHMARK"), start + 2).ok).toBe(false);
    expect(applyP7BenchmarkEntry(quoted(), ledger, profile, "localObserving", command("OBSERVE_BENCHMARK_BOOK"), start + 2).ok).toBe(false);
  });
  it("retains invalid evidence and permits an explicit request only before eligibility", () => {
    const rejected = next(requested(), "OBSERVE_BENCHMARK_BOOK", start + 1, { book: { ...book, cacheStatus: "UNKNOWN" } });
    expect(rejected.products["BTC-USD"]?.phase).toBe("rejected");
    expect(next(rejected, "REQUEST_BENCHMARK", start + 2).products["BTC-USD"]?.attempt).toBe(2);
  });
  it("fails stale/depth-limited fixed quotes without resizing or substitution", () => {
    expect(next(quoted(), "RESOLVE_BENCHMARK", start + 5_002).products["BTC-USD"]?.reason).toBe("STALE_AT_USE");
    const limited = next(requested(), "OBSERVE_BENCHMARK_BOOK", start + 1, { book: { ...book, asks: [{ price: 101, quantity: 1 }] } });
    expect(next(limited, "RESOLVE_BENCHMARK", start + 2).products["BTC-USD"]?.reason).toBe("INSUFFICIENT_DEPTH");
  });
  it("suspends recovery without a response and cannot label it an ordinary expiry", () => {
    expect(recoverP7BenchmarkEntry(requested(), "BTC-USD").action).toBe("SUSPEND");
    expect(applyP7BenchmarkEntry(requested(), ledger, profile, "localObserving", command("EXPIRE_BENCHMARK"), start + 7_200_001).ok).toBe(false);
  });
  it("requires profile/campaign/window and rejects caller prices", () => {
    expect(applyP7BenchmarkEntry(requested(), ledger, profile, "suspended", command("RESOLVE_BENCHMARK"), start + 1).ok).toBe(false);
    expect(applyP7BenchmarkEntry(emptyP7BenchmarkEntries(), ledger, profile, "localObserving", { ...command("EXPECT_BENCHMARK"), price: 1 }, start).ok).toBe(false);
    const expected = next(emptyP7BenchmarkEntries(), "EXPECT_BENCHMARK");
    expect(applyP7BenchmarkEntry(expected, ledger, null, "localObserving", command("REQUEST_BENCHMARK"), start).ok).toBe(false);
    expect(applyP7BenchmarkEntry(expected, ledger, profile, "localObserving", command("REQUEST_BENCHMARK"), start + 7_200_001).ok).toBe(false);
  });
  it("rejects a mode switch after observing a legacy initial market book", () => {
    expect(applyP7BenchmarkEntry(emptyP7BenchmarkEntries(), ledger, profile, "localObserving", command("EXPECT_BENCHMARK"), start, true)).toEqual({ ok: false, error: "BENCHMARK_MODE_ALREADY_OBSERVED" });
  });
  it("keeps expiry explicit and a suspended campaign from initializing a frozen book", () => {
    const expected = next(emptyP7BenchmarkEntries(), "EXPECT_BENCHMARK");
    expect(next(expected, "EXPIRE_BENCHMARK", start + 7_200_001).products["BTC-USD"]?.phase).toBe("failed");
    const result = applyP7BenchmarkEntry(quoted(), ledger, profile, "suspended", command("RESOLVE_BENCHMARK"), start + 2);
    expect(result.ok && result.value.receipt.reason).toBe("CAMPAIGN_SAFETY_BLOCKED");
    expect(next(quoted(), "RESOLVE_BENCHMARK", start + 5_001).products["BTC-USD"]?.phase).toBe("initialized");
  });
});
