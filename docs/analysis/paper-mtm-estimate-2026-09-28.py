"""Estimation hors réseau de la valeur de marché des deux positions paper (capture du 2026-09-28).
Hypothèses explicites : frais paper 6 bps, prix de fill déduit du dailyPnl du cycle de fill (mark = close daily précédent).
Ce n'est PAS une mesure : le Worker déployé publie toujours l'équité au coût d'acquisition."""
import json
from pathlib import Path
ROOT = Path(__file__).parent / 'evidence-paper-2026-09-28'
daily = json.loads((ROOT / 'coinbase-daily-candles.json').read_text())
rows = json.loads((ROOT / 'campaign-cycles.json').read_text())['result']['data']
FEE_BPS = 6
out = {'assumptions': {'feeBps': FEE_BPS, 'fillDay': '2026-09-22', 'markAtFill': 'close daily 2026-09-21 (dernière bougie close)', 'source': 'coinbase-daily-candles.json ticker'}, 'products': {}}
total_cost = total_mtm = 0.0
for p in ('BTC-USD', 'ETH-USD'):
    fill = next(r for r in rows if r['product'] == p and r['execution'] == 1)
    qty = fill['position']
    closes = {c['day']: c['close'] for c in daily[p]['candles']}
    mark_fill = closes['2026-09-21']
    # dailyPnl(fill) = qty*(mark - fillPrice) - fee, fee = FEE_BPS/1e4 * qty*fillPrice
    # => fillPrice = (qty*mark - dailyPnl) / (qty*(1 + FEE_BPS/1e4))
    fill_price = (qty * mark_fill - fill['daily_pnl']) / (qty * (1 + FEE_BPS / 1e4))
    notional = qty * fill_price
    fee = notional * FEE_BPS / 1e4
    ticker = float(daily[p]['ticker']['price'])
    mtm = qty * ticker
    pnl = mtm - notional - fee
    out['products'][p] = {'quantity': qty, 'estimatedFillPrice': round(fill_price, 2), 'estimatedNotional': round(notional, 2), 'estimatedFee': round(fee, 3),
                          'tickerAt': daily[p]['ticker']['time'], 'ticker': ticker, 'marketValue': round(mtm, 2), 'unrealizedPnl': round(pnl, 2),
                          'unrealizedPct': round(pnl / (notional + fee) * 100, 2), 'priceChangeSinceFillPct': round((ticker / fill_price - 1) * 100, 2)}
    total_cost += notional + fee; total_mtm += mtm
out['portfolio'] = {'initialCapital': 20000, 'estimatedEquity': round(20000 - total_cost + total_mtm, 2), 'estimatedUnrealizedPnl': round(total_mtm - total_cost, 2),
                    'estimatedReturnPct': round((total_mtm - total_cost) / 20000 * 100, 3), 'exposureNotional': round(total_mtm, 2), 'exposurePctOfCapital': round(total_mtm / 20000 * 100, 2)}
(ROOT / 'mtm-estimate.json').write_text(json.dumps(out, indent=2) + '\n')
print(json.dumps(out, indent=2))
