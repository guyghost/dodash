// Résumé de session paper — lecture Analytics Engine `dodash_paper_trading`.
// Lecture seule : aucune écriture, aucune décision — les agrégats sont des
// signaux de télémétrie (models/trading-telemetry.md), jamais des transitions.
// Fenêtre: collecte #36 valide uniquement (>= 2026-09-04T17:01:15Z).
// Usage : CF_OAUTH=<token> node docs/analysis/paper-session-summary-2026-09-09.mjs
import { execSync } from "node:child_process";

const ACCT = "bab940ffcf652079ec6172c267afa11e";
const DATASET = "dodash_paper_trading";
const WINDOW_MS = String(Date.parse("2026-09-04T17:01:15Z")); // début collecte #36 (runbook §3)
const token = process.env.CF_OAUTH;
if (!token) {
  console.error("CF_OAUTH manquant");
  process.exit(1);
}

const sql = (query) => {
  let raw;
  try {
    raw = execSync(
      `curl -s -X POST https://api.cloudflare.com/client/v4/accounts/${ACCT}/analytics_engine/sql -H "Authorization: Bearer ${token}" -H "Content-Type: text/plain" --data ${JSON.stringify(query.replace(/\s+/g, " ").trim())}`,
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    return JSON.parse(raw);
  } catch {
    console.error("SQL échec:", query.slice(0, 120), "\n→", raw?.slice(0, 300));
    return { data: [] };
  }
};

const rows = (query) => sql(query).data ?? [];
const WHERE = `blob1 = 'cycle.completed' AND double1 >= ${WINDOW_MS}`;
const fmt = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
const num = (x) => Number(x ?? 0);

console.log(`Fenêtre #36 : >= ${new Date(Number(WINDOW_MS)).toISOString()}`);
const [vol] = rows(`SELECT count() AS n, min(timestamp) AS first, max(timestamp) AS last FROM ${DATASET} WHERE ${WHERE}`);
console.log(`Cycles: ${fmt.format(num(vol.n))} | ${vol.first} → ${vol.last} UTC`);

console.log("\n=== OUTCOMES PAR PRODUIT ===");
console.table(rows(`SELECT blob2 AS product, blob5 AS outcome, count() AS n FROM ${DATASET} WHERE ${WHERE} GROUP BY blob2, blob5 ORDER BY product, n DESC`));

console.log("\n=== CYCLES PAR JOUR (UTC) ===");
console.table(
  rows(`SELECT toDate(timestamp) AS day, count() AS cycles,
    sum(double7 = 1) AS executions,
    sum(blob5 = 'RISK_REJECTED') AS risk_rejected,
    sum(blob5 = 'FAILED') AS failed,
    sum(blob5 = 'ORDER_REJECTED') AS order_rejected,
    sum(blob5 IN ('ORDER_OUTCOME_UNKNOWN','TERMINAL_FAILED')) AS alarms
  FROM ${DATASET} WHERE ${WHERE} GROUP BY day ORDER BY day`),
);

console.log("\n=== RATE_LIMITED (errorCode) PAR JOUR ===");
console.table(rows(`SELECT toDate(timestamp) AS day, sum(blob6 = 'RATE_LIMITED') AS rl, count() AS cycles FROM ${DATASET} WHERE ${WHERE} GROUP BY day ORDER BY day`));

console.log("\n=== ORDER_REJECTED : DÉTAIL ===");
console.table(rows(`SELECT blob2 AS product, blob6 AS errorCode, count() AS n FROM ${DATASET} WHERE ${WHERE} AND blob5 = 'ORDER_REJECTED' GROUP BY product, errorCode ORDER BY product, n DESC`));

console.log("\n=== LATENCE : DISTRIBUTION (ms) ===");
console.table(
  rows(`SELECT intDiv(double2, 250) * 250 AS bucket_ms, count() AS n FROM ${DATASET} WHERE ${WHERE} GROUP BY bucket_ms ORDER BY bucket_ms`),
);
const [lat] = rows(`SELECT min(double2) AS min, max(double2) AS max, avg(double2) AS avg FROM ${DATASET} WHERE ${WHERE}`);
const SPLIT_MS = String(Date.parse("2026-09-08T00:00:00Z"));
const [latEarly] = rows(`SELECT avg(double2) AS avg FROM ${DATASET} WHERE ${WHERE} AND double1 < ${SPLIT_MS}`);
const [latLate] = rows(`SELECT avg(double2) AS avg FROM ${DATASET} WHERE ${WHERE} AND double1 >= ${SPLIT_MS}`);
console.log(`min ${fmt.format(num(lat.min))} / avg ${fmt.format(num(lat.avg))} / max ${fmt.format(num(lat.max))} ms — avant 09-08: ${fmt.format(num(latEarly.avg))} ms, depuis 09-08: ${fmt.format(num(latLate.avg))} ms`);

console.log("\n=== ÉQUITY PAR PRODUIT ET PAR JOUR (clôture UTC) ===");
console.table(
  rows(`SELECT toDate(timestamp) AS day, blob2 AS product, argMax(double4, double1) AS equity_close, max(double3) AS day_pnl_max, min(double3) AS day_pnl_min FROM ${DATASET} WHERE ${WHERE} AND double10 = 1 GROUP BY day, product ORDER BY day, product`),
);

console.log("\n=== PORTEFEUILLE COMBINÉ (échantillon 1 point/2h) ===");
const btc = rows(`SELECT toStartOfHour(timestamp) AS hour, argMax(double4, double1) AS eq, argMax(double5, double1) AS pos FROM ${DATASET} WHERE ${WHERE} AND blob2 = 'BTC-USD' AND double10 = 1 GROUP BY hour ORDER BY hour`);
const eth = rows(`SELECT toStartOfHour(timestamp) AS hour, argMax(double4, double1) AS eq, argMax(double5, double1) AS pos FROM ${DATASET} WHERE ${WHERE} AND blob2 = 'ETH-USD' AND double10 = 1 GROUP BY hour ORDER BY hour`);
const byHour = new Map(btc.map((r) => [r.hour, { hour: r.hour, btc: num(r.eq), btcPos: num(r.pos) }]));
for (const r of eth) {
  const e = byHour.get(r.hour) ?? { hour: r.hour, btc: null, btcPos: null };
  e.eth = num(r.eq);
  e.ethPos = num(r.pos);
  byHour.set(r.hour, e);
}
const combined = [...byHour.values()].map((e) => ({
  hour: e.hour,
  btc: e.btc,
  eth: e.eth ?? null,
  total: e.btc != null && e.eth != null ? e.btc + e.eth : null,
  btcPos: e.btcPos,
  ethPos: e.ethPos ?? null,
})).filter((e) => e.total != null);
const step = Math.max(1, Math.ceil(combined.length / 30));
console.table(combined.filter((_, i) => i % step === 0 || i === combined.length - 1));
const last = combined[combined.length - 1];
const first = combined[0];
console.log(`Total initial ~20000 → dernier ${fmt.format(last.total)} (${fmt.format(last.total - 20000)} USD, ${fmt.format((100 * (last.total - 20000)) / 20000)} %) | BTC ${fmt.format(last.btc - 10000)} | ETH ${fmt.format(last.eth - 10000)}`);
const trough = combined.reduce((m, e) => (e.total < m.total ? e : m), combined[0]);
console.log(`Creux combiné: ${fmt.format(trough.total)} le ${trough.hour} UTC (drawdown ${fmt.format(20000 - trough.total)} USD)`);

console.log("\n=== CONTINUITÉ : PLUS GRAND ÉCART ENTRE 2 CYCLES ===");
const stamps = rows(`SELECT double1 AS ts FROM ${DATASET} WHERE ${WHERE} GROUP BY ts ORDER BY ts`).map((r) => num(r.ts));
let maxGap = 0; let gapAt = 0;
for (let i = 1; i < stamps.length; i++) {
  const g = stamps[i] - stamps[i - 1];
  if (g > maxGap) { maxGap = g; gapAt = stamps[i - 1]; }
}
console.log(`${stamps.length} timestamps distincts | plus grand écart: ${(maxGap / 60000).toFixed(1)} min à ${utc(gapAt)}`);

console.log("\n=== ÉTAT COURANT (5 derniers cycles) ===");
console.table(
  rows(`SELECT double1 AS ts, blob2 AS product, blob5 AS outcome, double3 AS daily_pnl, double4 AS equity, double5 AS position FROM ${DATASET} WHERE ${WHERE} ORDER BY ts DESC LIMIT 5`)
    .map((r) => ({ ...r, ts: utc(r.ts) })),
);

console.log("\n=== ALARMES GELÉES (models/trading-telemetry.md) ===");
const [al] = rows(`SELECT sum(blob5 IN ('ORDER_OUTCOME_UNKNOWN','TERMINAL_FAILED')) AS fatal,
    sum(double7 = 0 AND blob5 = 'ORDER_CONFIRMED') AS confirmed_wo_exec,
    min(double3) AS pnl_min, max(double6) AS max_other_exposure
  FROM ${DATASET} WHERE ${WHERE} AND double10 = 1`);
console.log(`ORDER_OUTCOME_UNKNOWN / TERMINAL_FAILED : ${al.fatal}`);
console.log(`ORDER_CONFIRMED sans exécution observée : ${al.confirmed_wo_exec}`);
console.log(`dailyPnl min: ${fmt.format(num(al.pnl_min))} (seuil page: -1000) | exposition «other» max: ${fmt.format(num(al.max_other_exposure))} (seuil: 20000)`);

console.log("\n=== ORDER_REJECTED : PREMIER ET DERNIER, PAR JOUR ===");
const rej = rows(`SELECT toDate(timestamp) AS day, count() AS n FROM ${DATASET} WHERE ${WHERE} AND blob5 = 'ORDER_REJECTED' GROUP BY day ORDER BY day`);
const [rejFirst] = rows(`SELECT min(double1) AS ts FROM ${DATASET} WHERE ${WHERE} AND blob5 = 'ORDER_REJECTED'`);
console.table(rej);
console.log(`Premier ORDER_REJECTED: ${utc(num(rejFirst.ts))}`);

console.log("\n=== RATE_LIMITED PAR HEURE UTC (profil horaire) ===");
console.table(rows(`SELECT toHour(timestamp) AS heure_utc, sum(blob6 = 'RATE_LIMITED') AS rl, count() AS cycles FROM ${DATASET} WHERE ${WHERE} GROUP BY heure_utc ORDER BY heure_utc`));

function utc(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}
