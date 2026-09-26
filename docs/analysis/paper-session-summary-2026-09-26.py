"""Reproduit les métriques du rapport depuis la capture Cloudflare, sans réseau."""
from datetime import datetime, timedelta
import collections
import json
from pathlib import Path
import statistics

ROOT = Path(__file__).parent / 'evidence-paper-2026-09-26'
capture = json.loads((ROOT / 'campaign-cycles.json').read_text())
rows = capture['result']['data']
assert len(rows) < 10000, 'Capture potentiellement tronquée'
assert all(row['weight'] == 1 for row in rows), 'Échantillonnage incompatible avec continuité exacte'
assert all(row['event'] == 'cycle.completed' and row['mode'] == 'paper' for row in rows)
assert len({(r['product'], r['ts']) for r in rows}) == len(rows), 'Doublons'
summary = {'windowEnd': capture['windowEnd'], 'cycles': len(rows), 'products': {}}
for product in sorted({row['product'] for row in rows}):
    data = sorted((r for r in rows if r['product'] == product), key=lambda r: r['ts'])
    valued = [r for r in data if r['has_equity'] == 1]
    summary['products'][product] = {
        'cycles': len(data),
        'outcomes': dict(collections.Counter(r['outcome'] for r in data)),
        'errors': dict(collections.Counter(r['error'] for r in data)),
        'failed_by_error': dict(collections.Counter(r['error'] for r in data if r['outcome'] == 'FAILED')),
        'first': data[0], 'last': data[-1],
        'equity_unique': sorted({r['equity'] for r in valued}),
        'latency_mean_ms': statistics.mean(r['latency_ms'] for r in data),
        'max_gap_minutes': max((b['ts'] - a['ts']) / 60000 for a, b in zip(data, data[1:])),
        'fills': [r for r in data if r['execution'] == 1],
    }
# Dernières 24 heures avant la borne de capture.
recent_start = datetime.fromisoformat(capture['windowEnd']) - timedelta(days=1)
last_day = [r for r in rows if r['ts'] >= recent_start.timestamp() * 1000]
summary['recent_window'] = {
    'start': recent_start.isoformat(), 'end': capture['windowEnd'],
    'cycles': len(last_day),
    'outcomes_and_errors': dict(collections.Counter(r['outcome'] + ':' + r['error'] for r in last_day)),
}
(ROOT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({k: v for k, v in summary.items() if k != 'products'}, indent=2))
for product, data in summary['products'].items():
    print(product, data['cycles'], data['outcomes'], data['failed_by_error'])
