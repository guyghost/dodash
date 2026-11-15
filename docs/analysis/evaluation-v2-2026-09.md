# ÉVALUATION V2 — PnL absolu en métrique primaire

**Date** : 2026-09-04 · **Statut** : `RESEARCH_ONLY` · **Modèle** : amendement
« Évaluation v2 » de `models/backtest-diagnostics.md` (dao #39) ·
**Proposition** : swarm-dao #39 — branche
`feature/dao-39-eval-v2-absolute-pnl`, non poussée.

---

## 0. Méthode

Le rapport applique le modèle amendé et ne dit que ce que les chiffres disent,
en absolu. Aucune stratégie n'est activée ni déclarée edge.

**Métriques primaires** (seules habilitées à soutenir un verdict) : PnL absolu
net ($ et % du capital, réalisé et latent distincts), win rate liquidatif
(INV-26, `models/backtest-run.md`), drawdown maximal, Sharpe annualisé,
turnover, frais payés.

**Métrique contextuelle** : l'excess vs benchmark, rétrogradé. Il n'est
rapporté qu'accompagné du **régime du benchmark**, calculé — jamais déclaré à
la main — au seuil figé à zéro dans le modèle : rendement total du benchmark
buy-and-hold `>= 0` → `HAUSSIER`, `< 0` → `BAISSIER` (constante
`BENCHMARK_REGIME_THRESHOLD`, testée contre le modèle).

**Compatibilité de lecture (C3)** : les artefacts d'études passés sont lus en
place, sans réécriture. Une métrique absente d'un artefact legacy reste `null`
(le holdout ETC/ATOM précède INV-26 : son win rate liquidatif est rapporté
`n/a`, jamais approximé par le win rate par fills).

**Option de calibration POWER_THIRD (documentée)** : CLI
`--confidence-calibration POWER_THIRD`, ou config suite
`confidenceCalibration: "POWER_THIRD"` ; la calibration s'applique à
`ema-cross` et `breakout`, `rsi-reversion` reste en identité (protocole
`models/confidence-calibration.md`). Script standard :
`pnpm --filter @dodash/backtest eval:v2` →
`.artifacts/studies/evaluation-v2-2026-09.json`.

## 1. Fenêtre principale — BTC-USD 365 j, rejeu v1 vs POWER_THIRD

Dataset unique rejoué deux fois : `coinbase:BTC-USD:ONE_DAY:1756684800000:1788220800000:2b8ea24b…1930`
(365 bougies, 2025-09-01 → 2026-09-01, même empreinte que l'analyse du
2026-09-04). Benchmark buy-and-hold : **−2 748,14 $ (−27,48 %)** — régime
calculé **BAISSIER**. Config défauts du dépôt (capital 10 000 $, notional
cible 1 000 $, frais 6 bps + slippage 2 bps, exécution `NEXT_CANDLE_OPEN`,
spot long-only) ; seule variable : la calibration.

| Calibration | Stratégie | Trades | Notional médian demandé | **PnL absolu** | Réalisé / latent | Win rate liq. | Drawdown | Sharpe | Turnover | Frais | Excess (ctx) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 IDENTITY | rsi-reversion | 29 | 537,90 $ | **−1 024,69 $** | +45,16 / −1 069,85 | 83,33 % | 35,02 % | −0,075 | 1,49 | 8,95 $ | +17,23 pts |
| v1 IDENTITY | ema-cross | 13 | 0,77 $ | **+0,49 $** | −0,52 / +1,01 | 14,29 % | 0,02 % | +0,245 | 0,00 | 0,01 $ | +27,49 pts |
| v1 IDENTITY | breakout | 28 | 10,61 $ | **−4,57 $** | −18,91 / +14,34 | 9,09 % | 0,21 % | −0,208 | 0,04 | 0,26 $ | +27,44 pts |
| v1 IDENTITY | ensemble | 38 | — | **−1 021,96 $** | +40,90 / −1 062,86 | 50,00 % | 34,95 % | −0,075 | 1,49 | 8,94 $ | +17,26 pts |
| POWER_THIRD | rsi-reversion | 29 | 537,90 $ | **−1 024,69 $** | +45,16 / −1 069,85 | 83,33 % | 35,02 % | −0,075 | 1,49 | 8,95 $ | +17,23 pts |
| POWER_THIRD | ema-cross | 14 | 91,58 $ | **−19,36 $** | −58,35 / +38,99 | 28,57 % | 0,87 % | −0,247 | 0,14 | 0,83 $ | +27,29 pts |
| POWER_THIRD | breakout | 28 | 219,76 $ | **−176,15 $** | −332,06 / +155,91 | 9,09 % | 3,78 % | −0,635 | 0,66 | 3,97 $ | +25,72 pts |
| POWER_THIRD | ensemble | 42 | — | **−779,37 $** | +2,68 / −782,05 | 54,55 % | 33,02 % | −0,028 | 1,58 | 9,47 $ | +19,69 pts |

\* Décomposition réalisée/latent du même run ; le notional médian demandé est
 celui des signaux actifs (diagnostic du run).

**Faits absolus** :

1. **Toutes les stratégies perdent en absolu sur cette fenêtre**, sauf
   ema-cross v1 à +0,49 $ — avec un notional demandé médian de 0,77 $ pour
   1 000 $ cibles : le résultat mesure l'absence de trading, pas une
   performance.
2. **POWER_THIRD restaure l'exposition** (notional médian demandé : ema-cross
   0,77 $ → 91,58 $, breakout 10,61 $ → 219,76 $) **et révèle des pertes** :
   ema-cross +0,49 $ → −19,36 $, breakout −4,57 $ → −176,15 $. La bande
   d'exposition [100 ; 400] $ confirmée par l'étude porte sur l'exposition,
   pas la rentabilité (`pnlUsedForVerdict: false`) — le rejeu en absolu le
   vérifie : exposition restaurée, edge non démontré.
3. **rsi-reversion est inchangé par la calibration** (stratégie non calibrée)
   et reste le premier destructeur de valeur : −10,25 % du capital, drawdown
   35,02 %, latent −1 069,85 $. Son win rate clôturé de 100 % devenait
   83,33 % liquidatif (INV-26) : la perte est latente, pas clôturée.
4. **L'excess contextuel (+17 à +27 pts) ne dit rien de positif** : tous les
   régimes calculés valent BAISSIER ; l'excess mesure une sous-exposition
   relative dans un marché −27 %, jamais un gain.

## 2. Holdout ETC/ATOM relu en absolu (artefact existant, aucun rejeu)

Source : `packages/backtest/.artifacts/studies/confidence-calibration-ETC-ATOM-2022-2026.json`
(`RESEARCH_ONLY`, protocole propre à l'étude : exits protecteurs 150/300,
exécution 6 h) — lu en place, empreinte inchangée. Profils retenus par
l'étude : POWER_THIRD. Win rate liquidatif absent de l'artefact (antérieur à
INV-26) : rapporté `n/a`, sans reconstitution.

| Produit | Benchmark (régime calculé) | Stratégie | Trades | **PnL absolu** | Retour | Drawdown | Sharpe | Turnover | Frais | Excess (ctx) |
|---|---|---|---|---|---|---|---|---|---|---|
| ETC-USD 2025-2026 | −7 178,67 $ (−71,79 %) BAISSIER | rsi-reversion | 113 | **−267,46 $** | −2,67 % | 2,89 % | −2,391 | 6,60 | 39,57 $ | +69,11 pts |
| ETC-USD | idem | ema-cross | 8 | **−2,86 $** | −0,03 % | 0,04 % | −0,774 | 0,07 | 0,41 $ | +71,76 pts |
| ETC-USD | idem | breakout | 12 | **−17,10 $** | −0,17 % | 0,17 % | −1,191 | 0,33 | 1,97 $ | +71,62 pts |
| ETC-USD | idem | ensemble | 125 | **−261,46 $** | −2,61 % | 2,78 % | −2,482 | 6,19 | 37,16 $ | +69,17 pts |
| ATOM-USD 2025-2026 | −6 840,43 $ (−68,40 %) BAISSIER | rsi-reversion | 167 | **−143,43 $** | −1,43 % | 2,14 % | −0,993 | 9,63 | 57,79 $ | +66,96 pts |
| ATOM-USD | idem | ema-cross | 8 | **−2,18 $** | −0,02 % | 0,06 % | −0,318 | 0,11 | 0,66 $ | +68,38 pts |
| ATOM-USD | idem | breakout | 18 | **+13,47 $** | +0,13 % | 0,13 % | +0,569 | 0,49 | 2,96 $ | +68,53 pts |
| ATOM-USD | idem | ensemble | 173 | **−108,57 $** | −1,09 % | 1,63 % | −0,823 | 8,75 | 52,49 $ | +67,31 pts |

**Faits absolus** : en relecture absolue, 7 scénarios sur 8 sont perdants ;
le seul gain est breakout ATOM-USD à +13,47 $ (+0,13 %, 18 trades) — petit
échantillon, aucun critère primaire (Sharpe +0,569 sur un an) ne soutient un
verdict. Les excess de +67 à +72 pts coexistent avec deux benchmarks à
−68/-72 % : ils quantifient la sous-exposition, ils ne la monétisent pas.

## 3. Verdicts v2 (faits mesurés, aucune activation, aucun edge déclaré)

| Stratégie | Lecture v2 en absolu |
|---|---|
| rsi-reversion | Perte absolue sur les trois fenêtres mesurées (−10,25 % principal ; −2,67 % ETC ; −1,43 % ATOM). Drawdown 35 % du capital. Win rate clôturé ≠ win rate liquidatif : perte latente −1 069,85 $. |
| ema-cross | v1 (+0,49 $) = artefact d'inactivité (notional médian 0,77 $). Exposition restaurée (POWER_THIRD) : −19,36 $. Holdout : −0,03 %. |
| breakout | v1 ≈ 0 (inactivité). Exposition restaurée : −176,15 $ sur la fenêtre principale. Holdout : −0,17 % ETC, +0,13 % ATOM (18 trades, non concluant). |
| ensemble | Perdant en absolu sous les deux calibrations (−1 021,96 $ v1 ; −779,37 $ POWER_THIRD) ; dominé par l'exposition rsi. |
| funding-trend | Hors périmètre de ce rejeu (verdict §3 de l'analyse du 2026-09-04 : inopérante, 0 trade). |

## 4. Vérifications

- Métriques primaires et régime testées
  (`packages/backtest/test/evaluation-v2.test.ts`) : seuil figé cohérent avec
  le modèle, primaires reportées telles quelles, excess toujours accompagné du
  régime calculé, artefact legacy lu avec `winRateLiquidative = null` sans
  approximation, entrées invalides refusées.
- Artefacts d'études passés préservés : lecture seule, empreinte SHA-256 du
  holdout ETC/ATOM inchangée (`fde29829…b724a`).
- `pnpm check`, `pnpm test`, `pnpm build`, `pnpm lint` : sans nouveau warning.

## 5. Points ouverts

1. **Fenêtre principale baissière unique** : le régime calculé est BAISSIER
   sur toutes les fenêtres mesurées ; aucun scénario haussier n'a pu être
   rejoué avec l'outillage actuel (timeout > 365 bougies journalières, cf.
   analyse du 2026-09-04, §5).
2. **Le notional restauré par POWER_THIRD reste sous la cible** : médiane
   91,58 $ (ema-cross) et 219,76 $ (breakout) pour 1 000 $ cibles — dans la
   bande d'étude [100 ; 400] $ pour breakout, sous la bande pour ema-cross
   sur cette fenêtre.
3. **Breakout ATOM +0,13 %** : seul résultat positif mesuré ; 18 trades,
   aucune significativité revendicable. À re-vérifier sur d'autres fenêtres
   avant toute hypothèse.
4. **Le win rate liquidatif des artefacts legacy reste null** : une
   re-génération des études sous INV-26 serait nécessaire pour comparer
   directement clôturé vs liquidatif sur le holdout.

---

Reproductibilité : `pnpm --filter @dodash/backtest eval:v2` (fetch Coinbase
réel) → artefact `packages/backtest/.artifacts/studies/evaluation-v2-2026-09.json`.
Rapport généré à partir de la sortie réelle du 2026-09-04 ; aucun chiffre
inventé. Aucune stratégie activée, aucun push effectué, brief non committé.
