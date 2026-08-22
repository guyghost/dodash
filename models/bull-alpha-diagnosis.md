# Diagnostic : écart d'alpha en année bull (ensemble)

> Mesures du 2026-08-22. Contexte : après Verify de `regime-slope.md`, aucun
> mode de régime n'améliore sensiblement le win rate ; l'écart structural
> est ailleurs. Ce document est un diagnostic mesuré, pas un modèle de
> comportement — il motive le modèle `regime-exit.md`.

## Question

Pourquoi l'ensemble est-il à −125 pt d'excess vs buy-and-hold en année bull
(+125 %) pendant qu'il gagne en année bear (−24 % buy-and-hold) ?

## Données

BTC-USD ONE_DAY, protective 300/600 (sauf mention), notional cible 1000,
capital initial 10 000, exécution au plus tard au close suivant, frais 6 bps.

## Mesures

### 1. Les limites de risque ne sont PAS la cause (variantes isolées)

Script `packages/backtest/scripts/risk-attribution.ts` : une seule variable
de `RiskConfig` changée à la fois, année bull, ensemble.

| Variante | return | trades | riskReject |
|---|---|---|---|
| baseline | −0,38 % | 52 | 70,6 % |
| maxDailyLoss ∞ | −0,38 % | 52 | 70,6 % |
| maxOrderNotional 10k | −0,38 % | 52 | 70,6 % |
| maxPositionNotional 100k | −0,38 % | 52 | 70,6 % |
| maxGrossExposure 200k | −0,38 % | 52 | 70,6 % |

**Toutes identiques.** Le taux de rejet à 70,6 % est donc intégralement
dû au seul rejet non configurable : `SPOT_SHORT_FORBIDDEN` (vente nette
sans position, majoritairement rsi-reversion qui vend un marché haussier).
Ces rejets sont protecteurs, pas une perte d'opportunité. Nota : le
`dailyPnl` transmis au risk engine est le PnL cumulé depuis l'origine
(jamais réinitialisé) — sans effet ici, mais sémantiquement faux ; à
modéliser si un jour la limite journalière devient contraignante.

### 2. Le protective exit est LE levier dominant — et son effet s'inverse avec le régime

| Fenêtre | sans protective | fixed 300/600 | effet exits |
|---|---|---|---|
| bull 2023-08→2024-08 | **+7,42 %**, wr 100 %, 56 trades | −0,38 %, wr 35 %, 11 stops / 6 takes | **−7,8 pt** |
| bear 2025-08→2026-08 | **−15,13 %**, dd 30,3 % | +3,70 %, dd 3,3 %, 29 stops | **+18,8 pt** |

Symétrie : les exits détruisent la valeur en régime haussier (stop 300 bps
coupe des gagnants qui reculent avant leur take) et en créent massivement
en régime baissier. Sans eux, l'année bull est déjà positive avec 100 % de
win rate — le « problème de win rate » bull est entièrement causé par les
exits, pas par les signaux.

### 3. Le résiduel restant est l'exposition structurelle

Même sans exits (+7,42 % en bull), l'écart vs buy-and-hold reste ~118 pt :
l'ensemble n'est investi qu'une faible fraction du temps (médiane du
notional approuvé = 0 $, ~50 trades, dimensionnement par confiance).
C'est la nature d'un bot à signaux ; ce n'est pas un bug.

## Conclusion

La prochaine fonctionnalité modélisable à plus fort impact mesuré :
**protective exit conditionné au régime** — BULLISH → pas d'exit (ou large),
BEARISH/RANGE → FIXED_BPS serré. Gain théorique plafonné ≈ +7,4 % bull tout
en conservant +3,7 % bear. À modéliser dans `regime-exit.md` (cycle
Model → Review → Implement → Verify).
