import { isP7DepthBook } from "./p7-prospective-quote.js";
import { consumeP7Depth } from "./p7-prospective-pricing.js";
type Product = "BTC-USD" | "ETH-USD";
export interface P7BenchmarkProfile {
  readonly sourceProfileId: string; readonly profileSha256: string;
  readonly quantityDecimals: Readonly<Record<Product, number>>;
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: object, names: readonly string[]): boolean => Object.keys(v).length === names.length && Object.keys(v).every((k) => names.includes(k));
const decimals = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 12;
export const registerP7BenchmarkProfile = (current: P7BenchmarkProfile | null,
  manifest: { readonly campaignId: string; readonly sourceProfileId: string; readonly startAt: number }, input: unknown, recordedAt: number):
  { readonly ok: true; readonly value: P7BenchmarkProfile } | { readonly ok: false; readonly error: string } => {
  if (current !== null) return { ok: false, error: "BENCHMARK_PROFILE_IMMUTABLE" };
  if (!record(input) || !keys(input, ["campaignId", "commandId", "event"]) || input.campaignId !== manifest.campaignId ||
    typeof input.commandId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.commandId) ||
    !Number.isSafeInteger(recordedAt) || recordedAt < 0 || recordedAt >= manifest.startAt || !record(input.event)) return { ok: false, error: "INVALID_BENCHMARK_PROFILE" };
  const e = input.event;
  if (!keys(e, ["type", "sourceProfileId", "profileSha256", "quantityDecimals"]) || e.type !== "REGISTER_BENCHMARK_PROFILE" ||
    e.sourceProfileId !== manifest.sourceProfileId || typeof e.profileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.profileSha256) ||
    !record(e.quantityDecimals) || !keys(e.quantityDecimals, ["BTC-USD", "ETH-USD"]) ||
    !decimals(e.quantityDecimals["BTC-USD"]) || !decimals(e.quantityDecimals["ETH-USD"])) return { ok: false, error: "INVALID_BENCHMARK_PROFILE" };
  return { ok: true, value: { sourceProfileId: manifest.sourceProfileId, profileSha256: e.profileSha256,
    quantityDecimals: { "BTC-USD": e.quantityDecimals["BTC-USD"], "ETH-USD": e.quantityDecimals["ETH-USD"] } } };
};

/** Benchmark-only sizing: fixed 10k budget, full known depth, no venue order. */
export const sizeP7BenchmarkBuy = (book: unknown, quantityDecimals: number):
  { readonly ok: true; readonly quantity: number; readonly units: number; readonly vwap: number; readonly cost: number } |
  { readonly ok: false; readonly reason: string } => {
  const fail = (reason: string): { readonly ok: false; readonly reason: string } => ({ ok: false, reason });
  if (!decimals(quantityDecimals)) return fail("INVALID_PRECISION");
  if (!isP7DepthBook(book)) return fail("BOOK_INVALID");
  const scale = 10 ** quantityDecimals;
  let totalQuantity = 0, totalNotional = 0;
  for (const level of book.asks) {
    const value = level.quantity * level.price;
    if (!Number.isFinite(value) || value <= 0 || totalQuantity + level.quantity === totalQuantity || totalNotional + value === totalNotional) return fail("NUMERIC_RANGE");
    totalQuantity += level.quantity;
    totalNotional += value;
  }
  const capacity = Math.floor(totalQuantity * scale);
  if (!Number.isSafeInteger(capacity) || capacity < 0 || !Number.isFinite(totalNotional) || totalNotional <= 0) return fail("NUMERIC_RANGE");
  const funded = (units: number) => {
    const quantity = units / scale, price = consumeP7Depth(book, "BUY", quantity);
    if (!price.ok) return price;
    // Same operation order as executePaperOrder; no cash tolerance for sizing.
    const notional = price.vwap * 1.0002 * quantity, cost = notional + notional * 0.006;
    return Number.isFinite(cost) && cost > 0 ? { ok: true as const, quantity, units, vwap: price.vwap, cost } : fail("NUMERIC_RANGE");
  };
  let low = 0, high = capacity;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2), candidate = funded(middle);
    if (!candidate.ok && candidate.reason !== "INSUFFICIENT_DEPTH") return candidate;
    if (candidate.ok && candidate.cost <= 10_000) low = middle; else high = middle - 1;
  }
  if (!Number.isSafeInteger(low + 1) || (low + 1) / scale <= low / scale) return fail("NUMERIC_RANGE");
  const nextQuantity = (low + 1) / scale;
  if (nextQuantity > totalQuantity) {
    const lastAsk = book.asks.at(-1)?.price;
    if (lastAsk === undefined) return fail("BOOK_INVALID");
    const minimalNotional = totalNotional + (nextQuantity - totalQuantity) * lastAsk;
    const minimalCost = minimalNotional * 1.0002 * 1.006;
    if (!Number.isFinite(minimalCost)) return fail("NUMERIC_RANGE");
    if (minimalCost <= 10_000) return fail("INSUFFICIENT_DEPTH");
  } else {
    const next = funded(low + 1);
    if (!next.ok || next.cost <= 10_000) return fail("NUMERIC_RANGE");
  }
  if (low === 0) return fail("ZERO_FUNDED_LOTS");
  const result = funded(low);
  return result.ok && result.cost > 10_000 ? fail("NUMERIC_RANGE") : result;
};
