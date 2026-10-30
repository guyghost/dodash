/**
 * Balayage rétrospectif v2 LOCAL (§9) — candles Coinbase publiques + Jev
 * via gateway + fonctions pures du dépôt. Contournement d'un DO épinglé à
 * une ancienne version de classe ; le résultat alimente le duel ECE v1/v2.
 *
 * Usage (depuis apps/agent) :
 *   npx tsx scripts/v2-local-sweep.mts <fromMs> <toMs> [stepMinutes]
 */
import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolveTrendThresholdBps, composeTrendFromBatteryV2, resolveVolScaledOutcome, mapOpenAiQuestions } from "@dodash/models";
import {
	computeTrendFeaturesV2,
	buildTrendQuestionsV2,
	extractBatteryProbabilities,
} from "../src/ai-trend-producer.js";
import type { Candle } from "@dodash/domain";

const env = Object.fromEntries(
	readFileSync(resolve_repo(".env"), "utf8")
		.split("\n")
		.filter((l) => l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
function resolve_repo(p: string): string {
	// .env à la racine du dépôt (trois niveaux au-dessus de apps/agent/scripts)
	return new URL(`../../../${p}`, import.meta.url).pathname;
}

const FROM = Number(process.argv[2]);
const TO = Number(process.argv[3]);
const STEP = Number(process.argv[4] ?? 1); // minutes entre bougies échantillonnées
const MIN = 60_000;
const OUT = "/tmp/v2-local-signals.jsonl";

const fetchCandles = async (endMs: number, limit: number): Promise<Candle[]> => {
	const url = `https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles?start=${Math.floor((endMs - limit * MIN) / 1000)}&end=${Math.floor(endMs / 1000)}&granularity=ONE_MINUTE&limit=${limit}`;
	const res = await fetch(url, { headers: { accept: "application/json" } });
	if (!res.ok) throw new Error(`coinbase ${res.status}`);
	const body = (await res.json()) as { candles?: Record<string, string>[] };
	return (body.candles ?? []).map((c) => ({
		start: Number(c.start) * 1000,
		open: Number(c.open),
		high: Number(c.high),
		low: Number(c.low),
		close: Number(c.close),
		volume: Number(c.volume),
	}));
};

const decide = async (input: string, questions: unknown[]) => {
	const res = await fetch("https://ai-gateway.vercel.sh/v1/decisions", {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.AI_GATEWAY_KEY}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ model: "typesafe-ai/jev", input, questions }),
		signal: AbortSignal.timeout(8_000),
	});
	if (!res.ok) return null;
	return (await res.json()) as { answers?: { type: string; name?: string; probability?: number }[] };
};

if (!existsSync(OUT)) writeFileSync(OUT, "");
const candleCache = new Map<number, Candle>();
const referenceCandles: number[] = [];
for (let c = FROM; c <= TO; c += STEP * MIN) referenceCandles.push(c);

let collected = 0;
let skipped = 0;
let unavailable = 0;
const seen = new Set(
	readFileSync(OUT, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l).candleClosedAt as number),
);

for (let i = 0; i < referenceCandles.length; i += 48) {
	const batch = referenceCandles.slice(i, i + 48);
	const maxC = Math.max(...batch);
	let window: Candle[];
	try {
		window = await fetchCandles(maxC + MIN, batch.length * STEP + 190);
	} catch {
		unavailable += batch.length;
		continue;
	}
	for (const c of window) candleCache.set(c.start, c);
	for (const C of batch) {
		if (seen.has(C)) {
			skipped++;
			continue;
		}
		const closed = [...candleCache.values()].filter((k) => k.start + MIN <= C).sort((a, b) => a.start - b.start);
		const features = await computeTrendFeaturesV2("BTC-USD", closed);
		if (features === null) {
			unavailable++;
			continue;
		}
		const answer = await decide(JSON.stringify(features), mapOpenAiQuestions(buildTrendQuestionsV2(features.thresholdBps)));
		if (answer === null || !Array.isArray(answer.answers)) {
			unavailable++;
			continue;
		}
		const battery = extractBatteryProbabilities(
			answer.answers.map((a) => ({
				kind: "PREDICATE" as const,
				id: a.name ?? "",
				probability: a.probability ?? 0,
			})),
		);
		const trend = battery === null ? null : composeTrendFromBatteryV2(battery.up, battery.down);
		if (trend === null) {
			unavailable++;
			continue;
		}
		const refClose = candleCache.get(C - MIN)?.close;
		const outClose = candleCache.get(C + 14 * MIN)?.close;
		const outcome =
			refClose !== undefined && outClose !== undefined
				? resolveVolScaledOutcome(refClose, outClose, features.thresholdBps)
				: "PENDING";
		appendFileSync(
			OUT,
			JSON.stringify({
				candleClosedAt: C,
				observedAt: Date.now(),
				bias: trend.bias,
				probability: trend.probability,
				thresholdBps: features.thresholdBps,
				outcome,
			}) + "\n",
		);
		collected++;
	}
	console.log(`batch ${i / 48 + 1}/${Math.ceil(referenceCandles.length / 48)} — collectés ${collected} · indisponibles ${unavailable} · sautés ${skipped}`);
}
console.log(`SWEEP LOCAL DONE — ${collected} signaux v2 → ${OUT}`);
