#!/usr/bin/env node
import { readFileSync } from "node:fs";
/**
 * Rapport de calibration du signal de tendance IA
 * (models/ai-trend-signal.md §8-§9) — pagination de la limite 288 bougies
 * par fenêtre, stratification par collection × question_version, ECE via
 * la fonction pure computeTrendCalibration (@dodash/models).
 *
 * Usage :
 *   CONTROL_API_TOKEN=… AGENT_NAME=… node scripts/ai-trend-calibration.mjs \
 *     [--days 7 | --from ms --to ms] [--timeframe ONE_MINUTE] [--horizon 15]
 *     [--collection SHADOW|RETROSPECTIVE|ALL] [--base https://…]
 *
 * Tout rapport incluant des lignes RETROSPECTIVE porte
 * RETROSPECTIVE_POSSIBLY_CONTAMINATED (INV 12).
 */
import { computeTrendCalibration } from "@dodash/models";

const args = process.argv.slice(2);
const arg = (name) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};

const base =
	arg("base") ??
	process.env.DODASH_BASE_URL ??
	"https://dodash-paper-agent.guyghost.workers.dev";
const agentName = arg("agent") ?? process.env.AGENT_NAME;
const token = process.env.CONTROL_API_TOKEN;
const timeframe = arg("timeframe") ?? "ONE_MINUTE";
const horizon = Number(arg("horizon") ?? 15);
const collection = arg("collection") ?? "ALL";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const D = timeframe === "ONE_DAY" ? DAY : HOUR;

let from = Number(arg("from") ?? 0);
let to = Number(arg("to") ?? 0);
if (!from || !to) {
	const days = Number(arg("days") ?? 7);
	const now = Date.now();
	to = Math.floor(now / D) * D - horizon * D;
	from = to - days * D;
}

if (!agentName || !token) {
	console.error("AGENT_NAME et CONTROL_API_TOKEN requis (env).");
	process.exit(1);
}

const rows = [];
for (let f = from; f <= to; f += 288 * D) {
	const t = Math.min(f + 287 * D, to);
	const url = `${base}/api/agents/${agentName}/ai-trend-calibration?from=${f}&to=${t}&timeframe=${timeframe}&horizon=${horizon}&collection=${collection}`;
	const response = await fetch(url, {
		headers: { authorization: `Bearer ${token}` },
	});
	if (!response.ok) {
		console.error(`HTTP ${response.status} sur ${new Date(f).toISOString()}`);
		continue;
	}
	const payload = await response.json();
	if (!payload.ok) {
		console.error("Erreur agent :", payload.code);
		continue;
	}
	rows.push(...payload.rows);
}

const strata = [
	["SHADOW", "v1"],
	["SHADOW", "v2"],
	["RETROSPECTIVE", "v1"],
	["RETROSPECTIVE", "v2"],
];
const fmt = (n) => (typeof n === "number" ? n.toFixed(3) : "—");
console.log(`# Calibration tendance IA — ${new Date().toISOString()}`);
console.log(
	`Fenêtre [${new Date(from).toISOString()} → ${new Date(to).toISOString()}] · ${timeframe} · horizon ${horizon} · ${rows.length} ligne(s)`,
);
let contaminated = false;
for (const [stratum, version] of strata) {
	const stratumRows = rows.filter(
		(row) => row.collection === stratum && row.questionVersion === version,
	);
	if (stratumRows.length === 0) continue;
	if (stratum === "RETROSPECTIVE") contaminated = true;
	const pending = stratumRows.filter((row) => row.outcome === "PENDING").length;
	const report = computeTrendCalibration(stratumRows);
	console.log(
		`\n## ${stratum} · question ${version} — ${stratumRows.length} ligne(s), ${pending} PENDING exclue(s)`,
	);
	if (!report.ok) {
		console.log("- aucune issue close : échantillon vide");
		continue;
	}
	console.log(
		`ECE = ${report.ece.toFixed(4)} sur ${report.sampleSize} issues closes`,
	);
	console.log("");
	console.log("| bin | effectif | confiance moyenne | précision |");
	console.log("|---|---|---|---|");
	for (const bin of report.bins) {
		if (bin.count === 0) continue;
		console.log(
			`| [${bin.lower.toFixed(1)}, ${bin.upper.toFixed(1)}[ | ${bin.count} | ${fmt(bin.meanProbability)} | ${fmt(bin.accuracy)} |`,
		);
	}
}
console.log("");
console.log(
	contaminated
		? "> ⚠️ RETROSPECTIVE_POSSIBLY_CONTAMINATED — INV 12 : ce rapport ne valide à lui seul aucune activation PAPER."
		: "> Rapport prospectif pur (SHADOW).",
);
