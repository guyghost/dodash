// Chantier 1 (dao #36, point 13-09) : décomposition coûts vs marché par créneau.
// Faits : télémétrie AE (équité, position, outcomes) + bougies publiques Coinbase.
// Modèle de coûts : broker paper feeBps=6 + slippageBps=2 (configuration.ts).
// Estimation, pas un chiffre de DO : le prix de fill est approché par la bougie
// horaire (interpolation), la part « marché » d'un cycle de fill inclut le
// mouvement 1 min précédant le fill. Aucune décision n'est dérivée ici.
import { execSync } from "node:child_process";

const ACCT = "bab940ffcf652079ec6172c267afa11e";
const DATASET = "dodash_paper_trading";
const START_MS = Date.parse("2026-09-04T17:01:15Z");
const END_MS = Date.parse("2026-09-18T17:01:15Z");
const token = process.env.CF_OAUTH;
if (!token) {
  console.error("CF_OAUTH manquant");
  process.exit(1);
}

const sqlRows = (query) => {
  const raw = execSync(
    `curl -s -X POST https://api.cloudflare.com/client/v4/accounts/${ACCT}/analytics_engine/sql -H "Authorization: Bearer ${token}" -H "Content-Type: text/plain" --data ${JSON.stringify(query.replace(/\s+/g, " ").trim())}`,
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw);
  if (!parsed.data) throw new Error(`SQL échec: ${raw.slice(0, 200)}`);
  return parsed;
};

const cycles = (product, from, to) =>
  sqlRows(
    `SELECT double1 AS ts, blob5 AS outcome, double4 AS equity, double5 AS pos, double10 AS hasEq
     FROM ${DATASET}
     WHERE blob1 = 'cycle.completed' AND blob2 = '${product}' AND double1 >= ${from} AND double1 < ${to}
     ORDER BY ts ASC LIMIT 30000`,
  );

const candles = (productId) => {
  // Coinbase plafonne à 300 bougies/requête : fenêtre découpée en tranches
  // de 240 h avec recouvrement, fusionnées et triées (dédupliquées par ts).
  const chunkMs = 240 * 3600e3;
  const all = [];
  for (let from = START_MS - 3600e3; from < END_MS + 3600e3; from += chunkMs) {
    const to = Math.min(from + chunkMs + 3600e3, END_MS + 2 * 3600e3);
    const start = new Date(from).toISOString();
    const end = new Date(to).toISOString();
    const raw = execSync(
      `curl -s "https://api.exchange.coinbase.com/products/${productId}/candles?granularity=3600&start=${start}&end=${end}"`,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`Candles échec: ${raw.slice(0, 200)}`);
    all.push(...parsed);
  }
  // Coinbase candles: [time(s), low, high, open, close, volume]
  const byTs = new Map(all.map((c) => [c[0], c]));
  return [...byTs.values()].map((c) => ({ ts: c[0] * 1000, close: c[4] }))
    .sort((a, b) => a.ts - b.ts);
};

const priceAt = (series, ts) => {
  if (series.length === 0) return null;
  if (ts <= series[0].ts) return series[0].close;
  for (let i = 1; i < series.length; i++) {
    if (ts <= series[i].ts) {
      const a = series[i - 1];
      const b = series[i];
      const w = (ts - a.ts) / (b.ts - a.ts || 1);
      return a.close + w * (b.close - a.close);
    }
  }
  return series[series.length - 1].close;
};

const FEE_BPS = 6;
const SLIP_BPS = 2;
const COST_RATE = (FEE_BPS + SLIP_BPS) / 10_000;
const fmt$ = (x) => `${x >= 0 ? "" : "-"}${Math.abs(x).toFixed(2)} USD`;
const fmtq = (x) => `${x.toFixed(4)}`;

for (const product of ["BTC-USD", "ETH-USD"]) {
  const { data, rows_before_limit_at_least } = cycles(product, START_MS, END_MS);
  if (data.length >= 30000 || (rows_before_limit_at_least ?? 0) > data.length + 100) {
    throw new Error(`Troncature possible pour ${product}: ${data.length} / ${rows_before_limit_at_least}`);
  }
  const series = candles(product);

  let fillNotional = 0;
  let fillQty = 0;
  let fillCycleDeltaEq = 0;
  let nonFillDeltaEq = 0;
  let fills = 0;
  const perDay = new Map();

  let eqBlips = 0;
  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1];
    const cur = data[i];
    if (Number(prev.hasEq) === 0 || Number(cur.hasEq) === 0) {
      eqBlips += Number(prev.hasEq) === 0 ? 1 : 0;
      continue; // équité non fiable (flag null) : pas de diff dérivable
    }
    const dEq = Number(cur.equity) - Number(prev.equity);
    const dPos = Math.abs(Number(cur.pos) - Number(prev.pos));
    const isFill = cur.outcome === "ORDER_CONFIRMED";
    const day = new Date(Number(cur.ts)).toISOString().slice(0, 10);
    const agg = perDay.get(day) ?? { day, fills: 0, notional: 0, cost: 0, fillDelta: 0, holdDelta: 0 };
    if (isFill && dPos > 0) {
      fills += 1;
      const px = priceAt(series, Number(cur.ts));
      const notional = dPos * px;
      fillQty += dPos;
      fillNotional += notional;
      fillCycleDeltaEq += dEq;
      agg.fills += 1;
      agg.notional += notional;
      agg.cost += notional * COST_RATE;
      agg.fillDelta += dEq;
    } else {
      nonFillDeltaEq += dEq;
      agg.holdDelta += dEq;
    }
    perDay.set(day, agg);
  }

  console.log(`Blips équité non fiable (flag null, valeurs 0 exclues des diffs) : ${eqBlips}`);
  const totalDelta = Number(data[data.length - 1].equity) - Number(data[0].equity);
  const cost = fillNotional * COST_RATE;
  const marketPnl = totalDelta - cost;
  const pxLast = priceAt(series, END_MS);
  const posLast = Number(data[data.length - 1].pos);

  console.log(`\n===== ${product} =====`);
  console.log(`Cycles: ${data.length} | fills: ${fills} | quantité échangée: ${fmtq(fillQty)} (${(fillQty * pxLast).toFixed(0)} USD au prix courant)`);
  console.log(`Notional échangé cumulé : ${fillNotional.toFixed(0)} USD (rotations ≈ ${(fillNotional / 10000).toFixed(1)}× le capital)`);
  console.log(`Coûts simulés (${FEE_BPS}+${SLIP_BPS} bps) : ${fmt$(cost)}`);
  console.log(`Δequité totale : ${fmt$(totalDelta)}`);
  console.log(`  → part marché/signal : ${fmt$(marketPnl)}`);
  console.log(`  → part coûts : ${fmt$(cost)} (${(100 * cost / Math.abs(totalDelta)).toFixed(0)} % du glissement)`);
  console.log(`Δequité cycles-fill : ${fmt$(fillCycleDeltaEq)} | Δequité hors-fill (portage) : ${fmt$(nonFillDeltaEq)}`);
  console.log(`PnL par fill (moyenne) : ${fmt$(fillCycleDeltaEq / (fills || 1))} | coût par fill : ${fmt$(cost / (fills || 1))}`);
  console.log(`Position finale : ${fmtq(posLast)} (${(posLast * pxLast).toFixed(0)} USD) — PnL latent sur position : ~${fmt$(posLast * (pxLast - priceAt(series, lastBuyTs(data))))}`);
  console.log("\n--- Par jour : fills / notional / coûts / Δ marché ---");
  console.table([...perDay.values()].map((d) => ({
    day: d.day,
    fills: d.fills,
    notional: d.notional.toFixed(0),
    couts: d.cost.toFixed(2),
    delta_fill: d.fillDelta.toFixed(2),
    delta_portage: d.holdDelta.toFixed(2),
  })));
}

function lastBuyTs(data) {
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i].outcome === "ORDER_CONFIRMED") return Number(data[i].ts);
  }
  return END_MS;
}
