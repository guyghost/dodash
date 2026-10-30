#!/usr/bin/env node
/**
 * Archive l'état complet d'un agent paper avant tout stop/start —
 * le stop/reset du 2026-10-30 a effacé le book runtime sans trace
 * (post-mortem : archiver AVANT toute commande de contrôle destructive).
 *
 * Usage :
 *   DASHBOARD_ACCESS_TOKEN=… AGENT_NAME=btc-usd-paper node scripts/archive-paper-state.mjs
 * Écrit .artifacts/paper/<agent>-<ISO>.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const agentName = process.env.AGENT_NAME ?? "btc-usd-paper";
const token = process.env.DASHBOARD_ACCESS_TOKEN;
const base =
	process.env.DODASH_BASE_URL ??
	"https://dodash-paper-dashboard-api.guyghost.workers.dev";
if (!token) {
	console.error("DASHBOARD_ACCESS_TOKEN requis (env).");
	process.exit(1);
}
const response = await fetch(`${base}/api/agents/${agentName}/state`, {
	headers: { authorization: `Bearer ${token}` },
});
if (!response.ok) {
	console.error(`HTTP ${response.status}`);
	process.exit(1);
}
const state = await response.json();
const dir = resolve(import.meta.dirname, "../../.artifacts/paper");
mkdirSync(dir, { recursive: true });
const file = `${dir}/${agentName}-${new Date().toISOString().replaceAll(":", "")}.json`;
writeFileSync(file, JSON.stringify(state, null, "\t"));
const summary = state.portfolioSummary?.value?.consolidated ?? {};
console.log(
	`archivé → ${file} (equity ${summary.equity ?? "?"} · dailyPnl ${summary.dailyPnl ?? "?"})`,
);
