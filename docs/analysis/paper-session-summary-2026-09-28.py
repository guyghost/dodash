"""Reproduit les métriques du rapport du 2026-09-28 depuis la capture Cloudflare, sans réseau."""
from datetime import datetime, timedelta, timezone
import collections
import json
from pathlib import Path
import statistics

ROOT = Path(__file__).parent / 'evidence-paper-2026-09-28'
capture = json.loads((ROOT / 'campaign-cycles.json').read_text())
rows = capture['result']['data']
assert len(rows) < 10000, 'Capture potentiellement tronquée'
assert all(row['weight'] == 1 for row in rows), 'Échantillonnage incompatible avec continuité exacte'
assert all(row['event'] == 'cycle.completed' and row['mode'] == 'paper' for row in rows)
assert len({(r['product'], r['ts']) for r in rows}) == len(rows), 'Doublons'
PREVIOUS_END_MS = 1790412671696  # borne de la capture du 26-09 (08:51:11.696Z)
iso = lambda ms: datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()
day = lambda ms: datetime.fromtimestamp(ms / 1000, timezone.utc).date().isoformat()

def describe(data):
    data = sorted(data, key=lambda r: r['ts'])
    return {
        'cycles': len(data),
        'outcomes': dict(collections.Counter(r['outcome'] for r in data)),
        'errors_any': dict(collections.Counter(r['error'] for r in data)),
        'failed_by_error': dict(collections.Counter(r['error'] for r in data if r['outcome'] == 'FAILED')),
        'recovered_by_error': dict(collections.Counter(r['error'] for r in data if r['outcome'] != 'FAILED' and r['error'] != 'NONE')),
        'first': iso(data[0]['ts']) if data else None, 'last': iso(data[-1]['ts']) if data else None,
        'latency_mean_ms': round(statistics.mean(r['latency_ms'] for r in data), 1) if data else None,
        'latency_max_ms': max(r['latency_ms'] for r in data) if data else None,
        'max_gap_minutes': round(max((b['ts'] - a['ts']) / 60000 for a, b in zip(data, data[1:])), 2) if len(data) > 1 else None,
        'equity_unique': sorted({r['equity'] for r in data if r['has_equity'] == 1}),
        'schema_v3_rows': sum(1 for r in data if r['val_quality'] not in ('', None)),
        'fills': [{'at': iso(r['ts']), 'outcome': r['outcome'], 'position_after': r['position'], 'daily_pnl': r['daily_pnl']} for r in data if r['execution'] == 1],
        'last_position': data[-1]['position'] if data else None,
        'last_daily_pnl': data[-1]['daily_pnl'] if data else None,
    }

summary = {'windowStart': iso(capture['windowStartMs']), 'windowEnd': capture['windowEnd'], 'cycles': len(rows),
           'span_days': round((max(r['ts'] for r in rows) - min(r['ts'] for r in rows)) / 86400000, 2),
           'products': {}, 'delta_since_2026_09_26': {}, 'daily': {}}
for product in sorted({r['product'] for r in rows}):
    data = [r for r in rows if r['product'] == product]
    summary['products'][product] = describe(data)
    summary['delta_since_2026_09_26'][product] = describe([r for r in data if r['ts'] >= PREVIOUS_END_MS])
    # Couverture par jour UTC : un jour est « évalué » s'il compte au moins un cycle non FAILED.
    by_day = collections.defaultdict(list)
    for r in data: by_day[day(r['ts'])].append(r)
    summary['daily'][product] = {
        d: {'cycles': len(v), 'failed': sum(1 for r in v if r['outcome'] == 'FAILED'),
            'evaluated': any(r['outcome'] != 'FAILED' for r in v),
            'last_daily_pnl': sorted(v, key=lambda r: r['ts'])[-1]['daily_pnl'],
            'last_daily_pnl_non_failed': next((r['daily_pnl'] for r in sorted(v, key=lambda r: r['ts'], reverse=True) if r['outcome'] != 'FAILED'), None),
            'errors': dict(collections.Counter(r['error'] for r in v if r['error'] != 'NONE'))}
        for d, v in sorted(by_day.items())}
summary['delta_total'] = describe([r for r in rows if r['ts'] >= PREVIOUS_END_MS])
# Répartition des erreurs par heure UTC (toutes fenêtres).
summary['errors_by_utc_hour'] = {
    err: dict(sorted(collections.Counter(datetime.fromtimestamp(r['ts'] / 1000, timezone.utc).hour for r in rows if r['error'] == err).items()))
    for err in ('RATE_LIMITED', 'STALE_MARKET_DATA')}
(ROOT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({k: v for k, v in summary.items() if k not in ('products', 'daily', 'delta_since_2026_09_26')}, indent=2))
for product, d in summary['products'].items():
    print('\n==', product, 'TOTAL', json.dumps({k: v for k, v in d.items()}, indent=1))
    print('== DELTA', json.dumps(summary['delta_since_2026_09_26'][product], indent=1))
    for dd, v in summary['daily'][product].items(): print('  ', dd, v)

# --- Couverture décisionnelle ONE_DAY ---------------------------------------
# La machine (models/trading-cycle.machine.ts) n'évalue une bougie daily qu'une
# fois (isDuplicateDecisionCandle) et seulement si triggeredAt - candleClosedAt
# <= maxMarketStalenessMs (2 h). Une « décision » est donc un cycle non FAILED
# dont l'erreur n'est pas STALE_MARKET_DATA (NO_ACTION+STALE = bougie trop
# vieille, jamais évaluée).
decided = lambda r: r['outcome'] != 'FAILED' and r['error'] != 'STALE_MARKET_DATA'
coverage = {}
for product in summary['products']:
    by_day = collections.defaultdict(list)
    for r in rows:
        if r['product'] == product: by_day[day(r['ts'])].append(r)
    coverage[product] = {}
    for d, v in sorted(by_day.items()):
        v.sort(key=lambda r: r['ts'])
        first = next((r for r in v if decided(r)), None)
        full_day = len([r for r in v if datetime.fromtimestamp(r['ts'] / 1000, timezone.utc).hour < 2]) == 2
        coverage[product][d] = {'full_day': full_day, 'decided_at': iso(first['ts']) if first else None,
                                'decision': (first['outcome'] + '/' + first['error']) if first else 'NONE',
                                'slots_00_01': [(iso(r['ts'])[11:16], r['outcome'], r['error']) for r in v if datetime.fromtimestamp(r['ts'] / 1000, timezone.utc).hour < 2]}
summary['daily_decision_coverage'] = coverage
summary['daily_decision_coverage_totals'] = {
    'full_product_days': sum(1 for p in coverage for d in coverage[p].values() if d['full_day']),
    'decided_full_product_days': sum(1 for p in coverage for d in coverage[p].values() if d['full_day'] and d['decision'] != 'NONE'),
    'lost': [(p, d) for p in coverage for d, v in coverage[p].items() if v['full_day'] and v['decision'] == 'NONE'],
}
rl_days = collections.Counter(day(r['ts']) for r in rows if r['error'] == 'RATE_LIMITED')
summary['rate_limited_cycles_by_day'] = dict(sorted(rl_days.items()))
hours = sorted({r['ts'] // 3600000 for r in rows if r['error'] == 'RATE_LIMITED'})
runs, start, prev = [], None, None
for h in hours:
    if prev is None or h != prev + 1:
        if start is not None: runs.append((start, prev))
        start = h
    prev = h
runs.append((start, prev))
summary['rate_limited_longest_hourly_streaks'] = [
    {'from': iso(s * 3600000), 'to': iso(e * 3600000), 'hours': e - s + 1} for s, e in sorted(runs, key=lambda r: r[1] - r[0], reverse=True)[:3]]
summary['latency_by_outcome_error'] = {
    f'{o}/{e}': {'n': len(v), 'mean_ms': round(statistics.mean(v)), 'max_ms': max(v)}
    for (o, e), v in sorted(collections.defaultdict(list, {
        k: [r['latency_ms'] for r in rows if (r['outcome'], r['error']) == k] for k in {(r['outcome'], r['error']) for r in rows}}).items())}
# Ancrage de fenêtre journalière au coût : premier cycle du jour FAILED alors que le précédent a échoué aussi.
anchored = []
for product in summary['products']:
    seq = sorted((r for r in rows if r['product'] == product), key=lambda r: r['ts'])
    for i in range(1, len(seq)):
        if day(seq[i]['ts']) != day(seq[i - 1]['ts']) and seq[i]['outcome'] == 'FAILED' and seq[i - 1]['outcome'] == 'FAILED':
            anchored.append((product, iso(seq[i]['ts'])))
summary['daily_window_opened_on_cost_basis'] = anchored
(ROOT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print('\n== couverture', json.dumps(summary['daily_decision_coverage_totals'], indent=1))
print('== 429/jour', summary['rate_limited_cycles_by_day'])
print('== séries 429', summary['rate_limited_longest_hourly_streaks'])
print('== ancrage au coût', anchored)
