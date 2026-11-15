#!/usr/bin/env node
/**
 * Sweep offline du coefficient de zone morte k (models/ai-trend-signal.md §9) :
 * θ = k × vol15. Les signaux v2 locaux portent thresholdBps = 0.5 × vol15 —
 * vol15 s'en dérive, et seules les CLASSES d'issue changent avec k (les closes
 * sont re-fetchées une fois). Coût : zéro appel Jev.
 *
 * Usage : npx tsx scripts/ai-trend-k-sweep.mts /tmp/v2-local-signals.jsonl [k1,k2,…]
 */
import { readFileSync } from "node:fs";
import {
	computeTrendCalibration,
	resolveVolScaledOutcome,
} from "@dodash/models";

const file = process.argv[2] ?? "/tmp/v2-local-signals.jsonl";
const ks = (process.argv[3] ?? "0.25,0.5,1,2").split(",").map(Number);
const MIN = 60_000;
const signals = readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.map(JSON.parse);
const from = Math.min(...signals.map((s) => s.candleClosedAt)) - MIN;
const to = Math.max(...signals.map((s) => s.candleClosedAt)) + 15 * MIN;

// Une passe de closes sur toute la fenêtre (5 requêtes publiques max).
const candles = new Map();
for (let end = to; end >= from; end -= 299 * MIN) {
	const url = `https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles?start=${Math.floor((end - 300 * MIN) / 1000)}&end=${Math.floor(end / 1000)}&granularity=ONE_MINUTE&limit=300`;
	const res = await fetch(url, { headers: { accept: "application/json" } });
	if (!res.ok) continue;
	const body = await res.json();
	for (const c of body.candles ?? []) {
		candles.set(Number(c.start) * 1000, Number(c.close));
	}
}
console.log(
	`échantillon ${signals.length} signaux · closes ${candles.size} · fenêtre ${new Date(from).toISOString()} → ${new Date(to).toISOString()}`,
);
for (const k of ks) {
	const samples = [];
	let pending = 0;
	for (const s of signals) {
		const refClose = candles.get(s.candleClosedAt - MIN);
		const outClose = candles.get(s.candleClosedAt + 14 * MIN);
		if (refClose === undefined || outClose === undefined) {
			pending++;
			continue;
		}
		const vol15 = s.thresholdBps / 0.5;
		const outcome = resolveVolScaledOutcome(refClose, outClose, k * vol15);
		if (outcome === null) continue;
		samples.push({
			productId: "BTC-USD",
			candleClosedAt: s.candleClosedAt,
			bias: s.bias,
			probability: s.probability,
			outcome,
		});
	}
	const report = computeTrendCalibration(samples);
	if (!report.ok) {
		console.log(`k=${k}: échantillon vide`);
		continue;
	}
	const acc =
		samples.filter((x) => x.bias === x.outcome).length / samples.length;
	console.log(
		`k=${k} → ECE=${report.ece.toFixed(4)} · issues=${report.sampleSize} (${pending} PENDING) · précision globale=${(acc * 100).toFixed(1)}%`,
	);
}
