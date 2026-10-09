"""Politiques d'allocation BTC/ETH — protocole figé models/allocation-policies-campaign.md (commit d620d5e).

Hors réseau : lit les bougies archivées de la campagne daily long
(docs/analysis/evidence-backtest-daily-long-2026-10-09/job--*.json).
Sortie : docs/analysis/evidence-allocation-policies-2026-10-09/summary.json + tableaux stdout.

Précision d'implémentation fixée AVANT le premier run (P6) : à la ré-entrée,
le plus haut de référence du coupe-circuit est remis à l'équité de ré-entrée ;
sans cela la règle se redéclencherait immédiatement.
"""
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

SRC = Path(__file__).parent / 'evidence-backtest-daily-long-2026-10-09'
OUT = Path(__file__).parent / 'evidence-allocation-policies-2026-10-09'
CAPITAL = 10_000.0
COST = 0.0062  # 60 bps + 2 bps par notionnel traité
DRIFT = 0.05
VOL_WINDOW = 30
VOL_TARGET = 0.50
TREND_WINDOW = 200
DD_EXIT = 0.35
REENTRY_RISE = 0.20
ELIGIBLE_MDD = 0.50
WINDOWS = [('W1', '2015-07-21', '2018-01-01'), ('W2', '2018-01-01', '2020-01-01'),
           ('W3', '2020-01-01', '2022-01-01'), ('W4', '2022-01-01', '2024-01-01'),
           ('W5', '2024-01-01', '2026-10-01')]
DAY = 86_400_000
ms = lambda s: int(datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp() * 1000)
dt = lambda t: datetime.fromtimestamp(t / 1000, timezone.utc)


def load():
    jobs = {p: json.loads((SRC / f'job--{p}.json').read_text()) for p in ('BTC-USD', 'ETH-USD')}
    btc = {c[0]: c[2] for c in jobs['BTC-USD']['candles']}
    eth = {c[0]: c[2] for c in jobs['ETH-USD']['candles']}
    dates = sorted(btc)
    assert all(b - a == DAY for a, b in zip(dates, dates[1:])), 'calendrier BTC discontinu'
    eth_start = min(eth)
    shas = {p: j['dataset']['sha256'] for p, j in jobs.items()}
    return dates, btc, eth, eth_start, shas


def indicators(dates, prices):
    """vol 30 j annualisée et tendance SMA200, causales (données jusqu'à t inclus)."""
    vol, trend = {}, {}
    seq = [(d, prices[d]) for d in dates if d in prices]
    closes = [p for _, p in seq]
    rets = [None] + [closes[i] / closes[i - 1] - 1 for i in range(1, len(closes))]
    for i, (d, p) in enumerate(seq):
        if i >= VOL_WINDOW:
            w = rets[i - VOL_WINDOW + 1:i + 1]
            m = sum(w) / len(w)
            vol[d] = math.sqrt(sum((r - m) ** 2 for r in w) / (len(w) - 1)) * math.sqrt(365)
        if i >= TREND_WINDOW - 1:
            trend[d] = p > sum(closes[i - TREND_WINDOW + 1:i + 1]) / TREND_WINDOW
    return vol, trend


class Book:
    def __init__(self):
        self.cash, self.units = CAPITAL, {'BTC': 0.0, 'ETH': 0.0}
        self.fees, self.orders = 0.0, 0

    def equity(self, px):
        return self.cash + sum(self.units[a] * px[a] for a in self.units if px.get(a))

    def weights(self, px):
        e = self.equity(px)
        return {a: (self.units[a] * px[a] / e if px.get(a) else 0.0) for a in self.units}

    def rebalance(self, px, target):
        e = self.equity(px)
        # Itération sur l'équité nette des frais : jamais de cash négatif (sans levier).
        net = e
        for _ in range(5):
            trades = {a: target[a] * net - (self.units[a] * px[a] if px.get(a) else 0.0) for a in self.units}
            fee = COST * sum(abs(v) for v in trades.values())
            net = e - fee
        for a, v in trades.items():
            if abs(v) > 1e-9:
                self.units[a] += v / px[a]
                self.orders += 1
        self.cash = e - fee - sum(self.units[a] * px[a] for a in self.units if px.get(a))
        self.fees += fee


def effective(target, has_eth):
    """Avant l'arrivée d'ETH, la poche ETH est détenue en BTC."""
    return target if has_eth else {'BTC': target['BTC'] + target['ETH'], 'ETH': 0.0}


def run(policy, dates, btc, eth, eth_start, vol, trend, shadow=None):
    book = Book()
    equity, exposure = [], []
    target = None
    state = {'in': True, 'peak': CAPITAL, 'trough': None, 'prev_trend': None, 'p0_switched': False}
    for i, d in enumerate(dates):
        px = {'BTC': btc[d], 'ETH': eth.get(d)}
        has_eth = d >= eth_start
        day = dt(d)
        month_start = day.day == 1
        monday = day.weekday() == 0
        e = book.equity(px)
        trade, new_target = False, None
        vol_w = lambda a, src: (0.5 * min(1.0, VOL_TARGET / vol[src][d]) if d in vol[src] else 0.0)
        src_of = lambda a: 'BTC' if (a == 'BTC' or not has_eth) else 'ETH'
        if policy == 'P0':
            if i == 0:
                new_target, trade = {'BTC': 1.0, 'ETH': 0.0}, True
            elif has_eth and not state['p0_switched']:
                new_target, trade = {'BTC': 0.5, 'ETH': 0.5}, True
                state['p0_switched'] = True
        elif policy in ('P1', 'P2', 'P3', 'P6'):
            share = {'P1': 1.0, 'P2': 0.7, 'P3': 0.5, 'P6': 1.0}[policy]
            base = effective({'BTC': share / 2, 'ETH': share / 2}, has_eth)
            if policy == 'P6':
                if state['in']:
                    state['peak'] = max(state['peak'], e)
                    if e <= state['peak'] * (1 - DD_EXIT):
                        state['in'], state['trough'] = False, shadow[i]
                        new_target, trade = {'BTC': 0.0, 'ETH': 0.0}, True
                else:
                    state['trough'] = min(state['trough'], shadow[i])
                    if shadow[i] >= state['trough'] * (1 + REENTRY_RISE):
                        state['in'], state['peak'] = True, e
                        new_target, trade = base, True
                if not state['in'] and new_target is None:
                    new_target = {'BTC': 0.0, 'ETH': 0.0}
            if new_target is None:
                new_target = base
        elif policy == 'P4':
            if i == 0 or monday or d == eth_start:
                new_target = {a: vol_w(a, src_of(a)) for a in ('BTC', 'ETH')}
                if not has_eth:
                    new_target = {'BTC': new_target['BTC'] + new_target['ETH'], 'ETH': 0.0}
                trade = True
        elif policy == 'P5':
            tr = {a: trend[src_of(a)].get(d, False) for a in ('BTC', 'ETH')}
            new_target = {a: 0.5 if tr[a] else 0.0 for a in tr}
            if not has_eth:
                new_target = {'BTC': new_target['BTC'] + new_target['ETH'], 'ETH': 0.0}
            if state['prev_trend'] is not None and tr != state['prev_trend']:
                trade = True
            state['prev_trend'] = tr
        elif policy == 'P7':
            tr = {a: trend[src_of(a)].get(d, False) for a in ('BTC', 'ETH')}
            changed = state['prev_trend'] is not None and tr != state['prev_trend']
            state['prev_trend'] = tr
            if i == 0 or monday or changed or target is None or d == eth_start:
                new_target = {a: (vol_w(a, src_of(a)) if tr[a] else 0.0) for a in ('BTC', 'ETH')}
                if not has_eth:
                    new_target = {'BTC': new_target['BTC'] + new_target['ETH'], 'ETH': 0.0}
                trade = trade or monday or changed or i == 0 or d == eth_start
        if new_target is not None:
            if target is None or new_target != target:
                if policy in ('P1', 'P2', 'P3', 'P5', 'P6') and target is not None and new_target != target:
                    trade = True
            target = new_target
        if target is not None and policy != 'P0':
            w = book.weights(px)
            drift = any(abs(w[a] - target[a]) > DRIFT for a in target)
            if month_start or drift or i == 0:
                trade = True
        if trade and target is not None:
            book.rebalance(px, target)
        e = book.equity(px)
        equity.append(e)
        exposure.append(1 - book.cash / e)
    return equity, exposure, book


def metrics(dates, equity):
    years = (len(equity) - 1) / 365.25
    rets = [equity[i] / equity[i - 1] - 1 for i in range(1, len(equity))]
    m = sum(rets) / len(rets)
    sd = math.sqrt(sum((r - m) ** 2 for r in rets) / (len(rets) - 1))
    peak, mdd = equity[0], 0.0
    for v in equity:
        peak = max(peak, v)
        mdd = max(mdd, 1 - v / peak)
    cagr = (equity[-1] / equity[0]) ** (1 / years) - 1
    return {'final': equity[-1], 'multiple': equity[-1] / CAPITAL, 'cagr': cagr, 'vol': sd * math.sqrt(365),
            'sharpe': 0.0 if sd == 0 else m / sd * math.sqrt(365), 'maxDrawdown': mdd,
            'calmar': cagr / mdd if mdd > 0 else None}


def main():
    dates, btc, eth, eth_start, shas = load()
    vb, tb = indicators(dates, btc)
    ve, te = indicators(dates, eth)
    vol, trend = {'BTC': vb, 'ETH': ve}, {'BTC': tb, 'ETH': te}
    results = {}
    shadow_p1, _, _ = run('P1', dates, btc, eth, eth_start, vol, trend)
    for policy in ('P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'):
        eq, ex, book = run(policy, dates, btc, eth, eth_start, vol, trend, shadow=shadow_p1)
        r = metrics(dates, eq)
        r.update({'meanExposure': sum(ex) / len(ex), 'orders': book.orders, 'fees': book.fees, 'minCash': min(0.0, book.cash)})
        r['years'] = {}
        for y in sorted({dt(d).year for d in dates}):
            idx = [i for i, d in enumerate(dates) if dt(d).year == y]
            start = eq[idx[0] - 1] if idx[0] > 0 else CAPITAL
            r['years'][y] = eq[idx[-1]] / start - 1
        r['windows'] = {}
        for wid, a, b in WINDOWS:
            idx = [i for i, d in enumerate(dates) if ms(a) <= d < ms(b)]
            start = eq[idx[0] - 1] if idx[0] > 0 else CAPITAL
            seg = [start] + [eq[i] for i in idx]
            peak, mdd = seg[0], 0.0
            for v in seg:
                peak = max(peak, v)
                mdd = max(mdd, 1 - v / peak)
            yrs = len(idx) / 365.25
            r['windows'][wid] = {'cagr': (seg[-1] / seg[0]) ** (1 / yrs) - 1, 'maxDrawdown': mdd}
        r['eligible'] = r['maxDrawdown'] <= ELIGIBLE_MDD and all(w['maxDrawdown'] <= ELIGIBLE_MDD for w in r['windows'].values())
        results[policy] = r
    p0 = results['P0']['cagr']
    for r in results.values():
        r['sacrifice'] = r['eligible'] and r['cagr'] < 0.5 * p0
    ranking = sorted([p for p, r in results.items() if r['eligible']], key=lambda p: -results[p]['cagr'])
    summary = {'protocol': 'models/allocation-policies-campaign.md (commit d620d5e)', 'datasetsSha256': shas,
               'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               'period': [dt(dates[0]).date().isoformat(), dt(dates[-1]).date().isoformat()], 'ethStart': dt(eth_start).date().isoformat(),
               'ranking': ranking, 'verdict': ranking[0] if ranking else 'AUCUNE', 'results': results}
    OUT.mkdir(exist_ok=True)
    (OUT / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
    print('période', summary['period'], 'verdict', summary['verdict'], 'classement', ranking)
    for p, r in results.items():
        print(f"{p} ×{r['multiple']:9.1f} CAGR {r['cagr']:+.1%} vol {r['vol']:.0%} Sh {r['sharpe']:.2f} MDD {r['maxDrawdown']:.1%} Calmar {r['calmar']:.2f} "
              f"expo {r['meanExposure']:.0%} ordres {r['orders']} frais {r['fees']:.0f} minCash {r['minCash']:.2f} éligible {r['eligible']} sacrifice {r['sacrifice']}")
        print('    fenêtres', {w: f"{v['cagr']:+.0%}/{v['maxDrawdown']:.0%}" for w, v in r['windows'].items()})
        print('    années', {y: f"{v:+.0%}" for y, v in r['years'].items()})


main()
