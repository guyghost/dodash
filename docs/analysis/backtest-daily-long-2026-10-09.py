"""Analyse figée de models/daily-edge-long-campaign.md (commit ab4458f), sans réseau.

Entrée : docs/analysis/evidence-backtest-daily-long-2026-10-09/job--<PRODUIT>.json
Sortie : summary.json dans le même dossier, tableaux sur stdout.
"""
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import random

ROOT = Path(__file__).parent / 'evidence-backtest-daily-long-2026-10-09'
PRODUCTS = ('BTC-USD', 'ETH-USD')
SCENARIOS = ('rsi-reversion', 'ema-cross:POWER_THIRD', 'breakout:POWER_THIRD')
ARMS = ('M40', 'T60', 'T120')
DECISION_ARM = 'T60'
ALPHA_LEVEL = 0.05 / 6
MC_DRAWS = 2_000
MC_SEED = 20261009
NW_LAGS = 5
FULL_YEARS = tuple(range(2016, 2026))
# Erratum de revue (PR #24) : protocole §2.4 — ETH 2016 est partielle (cotation
# le 2016-05-19) ; seules les années complètes de chaque actif comptent, et la
# majorité stricte se calcule sur cet ensemble (BTC 10 ans ⇒ ≥ 6, ETH 9 ⇒ ≥ 5).
COMPLETE_YEARS = {'BTC-USD': tuple(range(2016, 2026)), 'ETH-USD': tuple(range(2017, 2026))}
MIN_TRADES = 30
INITIAL_CAPITAL = 10_000
year_of = lambda ms: datetime.fromtimestamp(ms / 1000, timezone.utc).year


def normal_sf(z):
    return 0.5 * math.erfc(z / math.sqrt(2))


def ols_hac(y, x, lags=NW_LAGS):
    """OLS y = a + b x ; erreurs standard Newey-West (Bartlett)."""
    n = len(y)
    mx, my = sum(x) / n, sum(y) / n
    sxx = sum((xi - mx) ** 2 for xi in x)
    b = sum((xi - mx) * (yi - my) for xi, yi in zip(x, y)) / sxx
    a = my - b * mx
    e = [yi - a - b * xi for xi, yi in zip(x, y)]
    # (X'X)^-1 pour X = [1, x]
    s1, sx, sxx2 = n, sum(x), sum(xi * xi for xi in x)
    det = s1 * sxx2 - sx * sx
    inv = [[sxx2 / det, -sx / det], [-sx / det, s1 / det]]
    # S = Σ_l w_l Σ_t e_t e_{t-l} (x_t x_{t-l}' + x_{t-l} x_t')
    def g(t):
        return (e[t], e[t] * x[t])
    S = [[0.0, 0.0], [0.0, 0.0]]
    for t in range(n):
        u = g(t)
        for i in range(2):
            for j in range(2):
                S[i][j] += u[i] * u[j]
    for lag in range(1, lags + 1):
        w = 1 - lag / (lags + 1)
        for t in range(lag, n):
            u, v = g(t), g(t - lag)
            for i in range(2):
                for j in range(2):
                    S[i][j] += w * (u[i] * v[j] + v[i] * u[j])
    V = [[sum(inv[i][k] * S[k][l] * inv[l][j] for k in range(2) for l in range(2)) for j in range(2)] for i in range(2)]
    se_a = math.sqrt(max(V[0][0], 0.0))
    z = a / se_a if se_a > 0 else 0.0
    return {'alphaDaily': a, 'alphaAnnual': a * 365, 'beta': b, 'seAlphaDaily': se_a, 'z': z, 'pOneSided': normal_sf(z), 'n': n}


def sharpe(returns):
    if len(returns) < 2:
        return 0.0
    m = sum(returns) / len(returns)
    sd = math.sqrt(sum((r - m) ** 2 for r in returns) / (len(returns) - 1))
    return 0.0 if sd == 0 else m / sd * math.sqrt(365)


def max_drawdown(equity):
    peak, dd = equity[0], 0.0
    for e in equity:
        peak = max(peak, e)
        dd = max(dd, 1 - e / peak)
    return dd


def series(job, run):
    candles = job['candles']
    starts = [c[0] for c in candles]
    closes = [c[2] for c in candles]
    equity_by = {at: eq for at, eq in run['equity']}
    equity = [equity_by[s] for s in starts]
    trades = sorted(run['trades'], key=lambda t: t['executedAt'])
    q, cash, k = 0.0, float(INITIAL_CAPITAL), 0
    qty, recon = [], []
    for s, close in zip(starts, closes):
        while k < len(trades) and trades[k]['executedAt'] <= s:
            t = trades[k]
            if t['closedQuantity'] > 0:
                q -= t['closedQuantity']
                cash += t['closedQuantity'] * t['price'] - t['fee']
            else:
                q += t['quantity']
                cash -= t['quantity'] * t['price'] + t['fee']
            k += 1
        qty.append(max(q, 0.0))
        recon.append(cash + q * close)
    recon_err = max(abs(a - b) / b for a, b in zip(recon, equity))
    exposure = [qi * c / e for qi, c, e in zip(qty, closes, equity)]
    r_s = [equity[i] / equity[i - 1] - 1 for i in range(1, len(equity))]
    r_m = [closes[i] / closes[i - 1] - 1 for i in range(1, len(closes))]
    years = [year_of(starts[i]) for i in range(1, len(starts))]
    return {'starts': starts, 'closes': closes, 'equity': equity, 'exposure': exposure,
            'r_s': r_s, 'r_m': r_m, 'years': years, 'reconError': recon_err}


def blocks(exposure):
    out, cur = [], [exposure[0]]
    for e in exposure[1:]:
        if (e > 0) == (cur[-1] > 0):
            cur.append(e)
        else:
            out.append(cur)
            cur = [e]
    out.append(cur)
    return out


def monte_carlo(s, total_fees, rng):
    bl = blocks(s['exposure'][:-1])
    n = len(s['r_m'])
    c = total_fees / INITIAL_CAPITAL / n
    target = sharpe(s['r_s'])
    hits, draws = 0, []
    for _ in range(MC_DRAWS):
        order = bl[:]
        rng.shuffle(order)
        e = [v for b in order for v in b]
        rr = [e[t] * s['r_m'][t] - c for t in range(n)]
        sh = sharpe(rr)
        draws.append(sh)
        hits += sh >= target
    draws.sort()
    return {'strategySharpe': target, 'p': hits / MC_DRAWS,
            'p50': draws[MC_DRAWS // 2], 'p95': draws[int(MC_DRAWS * 0.95)], 'p99': draws[int(MC_DRAWS * 0.99)]}


def main():
    rng = random.Random(MC_SEED)
    summary = {'protocol': 'models/daily-edge-long-campaign.md (commit ab4458f)', 'datasets': {}, 'buyAndHold': {}, 'cells': [], 'verdicts': {}}
    jobs = {p: json.loads((ROOT / f'job--{p}.json').read_text()) for p in PRODUCTS}
    for p, job in jobs.items():
        summary['datasets'][p] = job['dataset'] | {'status': job['status']}
        closes, starts = [c[2] for c in job['candles']], [c[0] for c in job['candles']]
        by_year = {}
        for y in sorted({year_of(s) for s in starts}):
            idx = [i for i, s in enumerate(starts) if year_of(s) == y]
            prev = idx[0] - 1
            base = closes[prev] if prev >= 0 else job['candles'][idx[0]][1]
            ret = closes[idx[-1]] / base - 1
            regime = 'haussier' if ret > 0.20 else 'baissier' if ret < -0.20 else 'latéral'
            by_year[y] = {'return': ret, 'regime': regime, 'complete': y in COMPLETE_YEARS[p]}
        summary['buyAndHold'][p] = {'totalReturn': closes[-1] / job['candles'][0][1] - 1, 'years': by_year,
                                     'sharpe': sharpe([closes[i] / closes[i - 1] - 1 for i in range(1, len(closes))])}
    for p, job in jobs.items():
        regimes = {y: v['regime'] for y, v in summary['buyAndHold'][p]['years'].items()}
        for run in job['runs']:
            if run['status'] != 'OK':
                summary['cells'].append({'product': p, 'scenario': run['scenario'], 'arm': run['arm'], 'status': run['status'], 'raison': run.get('raison')})
                continue
            s = series(job, run)
            m = run['metrics']
            full = ols_hac(s['r_s'], s['r_m'])
            yearly = {}
            for y in sorted(set(s['years'])):
                ix = [i for i, yy in enumerate(s['years']) if yy == y]
                if len(ix) > 30 and any(s['r_m'][i] != 0 for i in ix):
                    r = ols_hac([s['r_s'][i] for i in ix], [s['r_m'][i] for i in ix])
                    yearly[y] = {'alphaAnnual': r['alphaAnnual'], 'beta': r['beta'], 'regime': regimes[y], 'complete': y in COMPLETE_YEARS[p]}
            positive_full_years = sum(1 for y in COMPLETE_YEARS[p] if y in yearly and yearly[y]['alphaAnnual'] > 0)
            majority_required = len(COMPLETE_YEARS[p]) // 2 + 1
            by_regime = {}
            for reg in ('haussier', 'baissier', 'latéral'):
                vals = [v['alphaAnnual'] for y, v in yearly.items() if v['regime'] == reg and v['complete']]
                by_regime[reg] = {'years': len(vals), 'meanAlphaAnnual': sum(vals) / len(vals) if vals else None}
            mc = monte_carlo(s, m['fees'], rng) if run['arm'] == DECISION_ARM else None
            time_in_market = sum(1 for e in s['exposure'] if e > 0) / len(s['exposure'])
            cell = {
                'product': p, 'scenario': run['scenario'], 'arm': run['arm'], 'status': 'OK',
                'trades': len(run['trades']), 'pnl': m['pnl'], 'totalReturn': m['totalReturn'], 'fees': m['fees'],
                'sharpeDaily': sharpe(s['r_s']), 'maxDrawdown': max_drawdown(s['equity']),
                'timeInMarket': time_in_market, 'meanExposureWhenIn': (sum(e for e in s['exposure'] if e > 0) / max(1, sum(1 for e in s['exposure'] if e > 0))),
                'reconstructionMaxRelError': s['reconError'],
                'alpha': full, 'alphaYearly': yearly, 'positiveAlphaFullYears': positive_full_years,
                'completeYears': len(COMPLETE_YEARS[p]), 'majorityRequired': majority_required, 'alphaByRegime': by_regime,
                'monteCarlo': mc,
            }
            if run['arm'] == DECISION_ARM:
                cell['criteria'] = {
                    'c1_alphaHac': full['alphaDaily'] > 0 and full['pOneSided'] < ALPHA_LEVEL,
                    'c2_monteCarlo': mc['p'] < ALPHA_LEVEL,
                    'c3_majorityYears': positive_full_years >= majority_required,
                    'c4_trades': len(run['trades']) >= MIN_TRADES,
                }
            summary['cells'].append(cell)
    for sc in SCENARIOS:
        cs = [c for c in summary['cells'] if c['scenario'] == sc and c['arm'] == DECISION_ARM and c['status'] == 'OK']
        ok = len(cs) == 2 and all(all(c['criteria'].values()) for c in cs)
        summary['verdicts'][sc] = {'edge': ok, 'byProduct': {c['product']: c['criteria'] for c in cs}}
    summary['verdict'] = 'EDGE' if any(v['edge'] for v in summary['verdicts'].values()) else "PAS D'EDGE"
    (ROOT / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
    print('VERDICT', summary['verdict'])
    for p in PRODUCTS:
        bh = summary['buyAndHold'][p]
        print(p, 'B&H total', round(bh['totalReturn'], 2), 'Sharpe', round(bh['sharpe'], 2),
              {y: (round(v['return'], 2), v['regime']) for y, v in bh['years'].items()})
    for c in summary['cells']:
        if c['status'] != 'OK':
            print(c)
            continue
        a = c['alpha']
        mc = c['monteCarlo']
        print(f"{c['product']} {c['scenario']:<22} {c['arm']:<5} n={c['trades']:<4} ret={c['totalReturn']:+.2f} Sh={c['sharpeDaily']:+.2f} DD={c['maxDrawdown']:.2f} "
              f"inMkt={c['timeInMarket']:.2f} expo={c['meanExposureWhenIn']:.2f} α={a['alphaAnnual']:+.4f} β={a['beta']:.3f} p={a['pOneSided']:.4f} "
              f"yrs+={c['positiveAlphaFullYears']}/{c['completeYears']} recon={c['reconstructionMaxRelError']:.1e}"
              + ('' if mc is None else f" MC p={mc['p']:.4f} (Sh {mc['strategySharpe']:+.2f} vs p50 {mc['p50']:+.2f} p99 {mc['p99']:+.2f})")
              + ('' if 'criteria' not in c else f" {c['criteria']}"))


main()
