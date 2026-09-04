# EDGE-RESEARCH — Campagne multi-régimes, grille v2 (DAO #40)

**Date** : 2026-09-04 · **Statut** : `RESEARCH_ONLY` · **Modèle** :
`models/edge-research-campaign.md` (grille figée au commit `168fa80`,
**antérieur au premier run de la grille** — C1, prouvé par l'historique git) ·
**Proposition** : swarm-dao #40 — branche `feature/dao-40-edge-research`,
non poussée. Brief non committé.

**Périmètre** : lecture-seule côté trading (C2). Aucune stratégie, machine ou
permission modifiée ; aucune activation. Les seuls ajouts de code sont le
script d'analyse `packages/backtest/scripts/edge-research-grid.ts` et ce
rapport. Tous les chiffres proviennent des sorties réelles des outils du
dépôt (C3) ; aucun échec de cellule à substituer (0 échec), aucune valeur
inventée.

---

## 0. Résumé exécutif

- **Grille exécutée intégralement** : 56 runs (2 actifs × 7 fenêtres ×
  2 calibrations × 2 bras de coûts), **168 cellules primaires OK, 0 échec,
  0 cellule non exécutable**, en 45,9 min au total.
- **Verdicts de criblage** : 80 « edge démontré » (étiquette de criblage,
  jamais une conclusion), 30 « non démontré », 58 « inactif ».
- **C4 — multiplicité** : sous l'hypothèse nulle, ~84 cellules positives
  sont attendues par pur hasard sur 168. Les 80 positives observées sont
  **cohérentes avec le bruit et une exposition long commune**, pas avec une
  découverte. **Aucune cellule ne devient une conclusion sans confirmation
  OOS.**
- **Candidates** : 80 cellules de criblage → **58 candidates dédupliquées**
  (règle figée) → **8 rejetées immédiatement** (contrôle nécessaire
  cross-actif non passé) → **50 en attente de la fenêtre OOS successor**
  `[2026-09-05, 2027-09-05)`, exécutable dès que les données existent.
- **Lecture d'ensemble honnête** : les résultats positifs se concentrent
  dans les fenêtres HAUSSIER (58/96 cellules actives positives) contre
  22/72 en BAISSIER ; la meilleure candidate (rsi-reversion sur la fenêtre
  complète) fait **+92,7 % là où le buy-and-hold fait +180,1 %** (excess
  contextuel **−87,4 pts**) avec un drawdown maximal de **66,79 %**. Le
  profil dominant est un **bêta long** sous-performant, pas un alpha.

## 1. Exécution

| Mesure | Valeur |
|---|---|
| Runs de suite | 56/56 OK |
| Cellules primaires | 168/168 OK, 0 échec, 0 non exécutable |
| Cellules informationnelles | 57 (56 `ensemble` + 1 `funding-trend` p75) |
| Durée murale totale | 45,9 min |
| Durée par run | FULL 178–189 s · années 27–29 s · Y2026 17–18 s |
| Datasets | 1 par (actif, fenêtre), partagés entre les 4 bras, SHA-256 consigné |

Datasets (début et empreinte, borne de fin exclusive 2026-09-04, dernier
jour clôturé 2026-09-03) :

| Actif | Fenêtre | Fin (exclusive) | datasetId (début:fin:sha256) |
|---|---|---|---|
| BTC-USD | FULL | 2026-09-04 | `1609459200000:1788480000000:35f8c476b32eff1cef15eeb1bd518d16e4726b6ee63312c97ad9072cac203e49` |
| BTC-USD | Y2021 | 2022-01-01 | `1609459200000:1640995200000:c3eeab7c20764464160437a0c70977248aace9d7de275c6861b77ef5a0196e00` |
| BTC-USD | Y2022 | 2023-01-01 | `1640995200000:1672531200000:bc8d2bdf62c0f00ab1d0996166a173587450a7cdcde3ed980880ec09f54dc07a` |
| BTC-USD | Y2023 | 2024-01-01 | `1672531200000:1704067200000:49d5e3dfae73bedc95e9937fdac57ee1e031dd029ae25239ea1bfe8ecb958197` |
| BTC-USD | Y2024 | 2025-01-01 | `1704067200000:1735689600000:32f607782b56b18e3fbd70f0cb60c13f8aad1d5850cd59b0ef71486a8b843e58` |
| BTC-USD | Y2025 | 2026-01-01 | `1735689600000:1767225600000:e8d1725818fc08af771221023311b6ba3370540adcbf65b2493fa2c70326b72d` |
| BTC-USD | Y2026 | 2026-09-04 | `1767225600000:1788480000000:e3624b7fa4e3a302c28ea431a12d95c2e5589e17864290401ca897a7cfac8091` |
| ETH-USD | FULL | 2026-09-04 | `1609459200000:1788480000000:69bf94c07e69b4ad7838109def984932ef7cbfb5de2582ac019e5f51d07868fc` |
| ETH-USD | Y2021 | 2022-01-01 | `1609459200000:1640995200000:8a2618630abea5f49f10cfbafd335d22356278bb8ba4ffaba210b181ab3c8988` |
| ETH-USD | Y2022 | 2023-01-01 | `1640995200000:1672531200000:22e6ffd2f3505c11cb4d4dfe1f8b4bedb8e599245f78bd9603b429b8257a0fcd` |
| ETH-USD | Y2023 | 2024-01-01 | `1672531200000:1704067200000:f7a0281fc53e52564cedc104bd626512be6bed9a04085a7b74b3495105f643b5` |
| ETH-USD | Y2024 | 2025-01-01 | `1704067200000:1735689600000:95f8beb56c33ae53997d471dcd58a4a3c315b0b940f7b6529a69519e5b0149e6` |
| ETH-USD | Y2025 | 2026-01-01 | `1735689600000:1767225600000:93d8b3342a52ee2089d5c1d23c4265b83ea2bcc9d7a566f97dd9b486a07d1346` |
| ETH-USD | Y2026 | 2026-09-04 | `1767225600000:1788480000000:d89c5c36ac645f870d86c316cecc4ad20f75ce4994184e25e335cd868f9d6d11` |

---

## 2. Régimes calculés par fenêtre

Le régime est **calculé** au seuil figé zéro de l'évaluation v2 à partir du
rendement du benchmark buy-and-hold de chaque fenêtre (jamais déclaré à la
main). Il est identique entre les bras ×1 et ×2 (écart de benchmark
< 0,5 pt, régime inchangé).

| Actif | Fenêtre | Benchmark buy-and-hold | Régime calculé |
|---|---|---|---|
| BTC-USD | FULL | +180,09 % | HAUSSIER |
| BTC-USD | Y2021 | +59,28 % | HAUSSIER |
| BTC-USD | Y2022 | −64,26 % | BAISSIER |
| BTC-USD | Y2023 | +155,59 % | HAUSSIER |
| BTC-USD | Y2024 | +120,58 % | HAUSSIER |
| BTC-USD | Y2025 | −6,34 % | BAISSIER |
| BTC-USD | Y2026 (246 j) | −7,20 % | BAISSIER |
| ETH-USD | FULL | +239,54 % | HAUSSIER |
| ETH-USD | Y2021 | +397,75 % | HAUSSIER |
| ETH-USD | Y2022 | −67,51 % | BAISSIER |
| ETH-USD | Y2023 | +90,69 % | HAUSSIER |
| ETH-USD | Y2024 | +45,88 % | HAUSSIER |
| ETH-USD | Y2025 | −10,99 % | BAISSIER |
| ETH-USD | Y2026 (246 j) | −15,55 % | BAISSIER |

La grille couvre 8 fenêtres haussières et 6 baissières (2 actifs ×
7 fenêtres) : le spectre multi-régimes demandé est atteint, ce qui
n'était pas possible avant #37.

## 3. Verdicts par cellule

Rappel des règles figées (`models/edge-research-campaign.md` §4, appliquées
dans cet ordre) : **inactif** si 0 trade ou médiane du notional demandé
< 100 $ (borne basse de la bande d'exposition confirmée [100 ; 400] $) ;
sinon **edge démontré** (criblage) si PnL absolu net > 0 et Sharpe > 0 ;
sinon **non démontré**. Métriques primaires uniquement ; WR liq. = win rate
liquidatif (INV-26) ; DD = drawdown maximal ; Méd. not. = médiane du
notional demandé (diagnostic du run). Y2026 est partielle (246 bougies).

#### BTC-USD — FULL · benchmark 18009.24 $ (180.09%) · régime calculé : **HAUSSIER**

| Stratégie | Calib. | Coûts | Trades | PnL net $ | Retour | Réalisé $ | Latent $ | WR liq. | DD max | Sharpe | Turnover | Frais $ | Méd. not. $ | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | IDENTITY | x1 | 53 | 9270.82 | 92.71% | 594.26 | 8676.56 | 94.1% | 66.79% | 0.400 | 269.3% | 16.16 | 547.6 | edge démontré |
| rsi-reversion | IDENTITY | x2 | 53 | 9222.64 | 92.23% | 581.19 | 8641.45 | 94.1% | 66.79% | 0.399 | 269.1% | 32.29 | 547.6 | edge démontré |
| rsi-reversion | POWER_THIRD | x1 | 53 | 9270.82 | 92.71% | 594.26 | 8676.56 | 94.1% | 66.79% | 0.400 | 269.3% | 16.16 | 547.6 | edge démontré |
| rsi-reversion | POWER_THIRD | x2 | 53 | 9222.64 | 92.23% | 581.19 | 8641.45 | 94.1% | 66.79% | 0.399 | 269.1% | 32.29 | 547.6 | edge démontré |
| ema-cross | IDENTITY | x1 | 62 | 32.67 | 0.33% | 12.57 | 20.10 | 76.7% | 0.35% | 0.328 | 1.2% | 0.07 | 1.8 | inactif |
| ema-cross | IDENTITY | x2 | 62 | 32.57 | 0.33% | 12.50 | 20.07 | 76.7% | 0.35% | 0.327 | 1.2% | 0.14 | 1.8 | inactif |
| ema-cross | POWER_THIRD | x1 | 63 | 1192.22 | 11.92% | 775.61 | 416.61 | 83.3% | 10.37% | 0.376 | 70.9% | 4.25 | 122.1 | edge démontré |
| ema-cross | POWER_THIRD | x2 | 63 | 1186.55 | 11.87% | 771.01 | 415.54 | 83.3% | 10.38% | 0.375 | 70.9% | 8.51 | 122.1 | edge démontré |
| breakout | IDENTITY | x1 | 197 | 798.78 | 7.99% | 51.68 | 747.10 | 71.6% | 15.08% | 0.207 | 44.9% | 2.69 | 16.1 | inactif |
| breakout | IDENTITY | x2 | 197 | 795.19 | 7.95% | 49.21 | 745.98 | 71.6% | 15.09% | 0.206 | 44.9% | 5.38 | 16.1 | inactif |
| breakout | POWER_THIRD | x1 | 96 | 8305.52 | 83.06% | -2117.87 | 10423.39 | 37.5% | 50.00% | 0.409 | 261.4% | 15.68 | 252.6 | edge démontré |
| breakout | POWER_THIRD | x2 | 96 | 8284.61 | 82.85% | -2133.74 | 10418.35 | 37.5% | 50.03% | 0.408 | 261.4% | 31.37 | 252.6 | edge démontré |

#### BTC-USD — Y2021 · benchmark 5927.62 $ (59.28%) · régime calculé : **HAUSSIER**

| Stratégie | Calib. | Coûts | Trades | PnL net $ | Retour | Réalisé $ | Latent $ | WR liq. | DD max | Sharpe | Turnover | Frais $ | Méd. not. $ | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | IDENTITY | x1 | 41 | 161.01 | 1.61% | 594.26 | -433.25 | 88.2% | 19.17% | 0.157 | 208.8% | 12.53 | 549.1 | edge démontré |
| rsi-reversion | IDENTITY | x2 | 41 | 144.30 | 1.44% | 581.19 | -436.88 | 88.2% | 19.21% | 0.152 | 208.8% | 25.05 | 549.1 | edge démontré |
| rsi-reversion | POWER_THIRD | x1 | 41 | 161.01 | 1.61% | 594.26 | -433.25 | 88.2% | 19.17% | 0.157 | 208.8% | 12.53 | 549.1 | edge démontré |
| rsi-reversion | POWER_THIRD | x2 | 41 | 144.30 | 1.44% | 581.19 | -436.88 | 88.2% | 19.21% | 0.152 | 208.8% | 25.05 | 549.1 | edge démontré |
| ema-cross | IDENTITY | x1 | 8 | -0.69 | -0.01% | -0.30 | -0.39 | 25.0% | 0.03% | -0.178 | 0.2% | 0.01 | 2.9 | inactif |
| ema-cross | IDENTITY | x2 | 8 | -0.70 | -0.01% | -0.31 | -0.40 | 25.0% | 0.03% | -0.182 | 0.2% | 0.02 | 2.9 | inactif |
| ema-cross | POWER_THIRD | x1 | 9 | 22.65 | 0.23% | 27.48 | -4.84 | 40.0% | 0.68% | 0.200 | 11.8% | 0.71 | 140.9 | edge démontré |
| ema-cross | POWER_THIRD | x2 | 9 | 21.70 | 0.22% | 26.62 | -4.93 | 40.0% | 0.68% | 0.192 | 11.8% | 1.42 | 140.9 | edge démontré |
| breakout | IDENTITY | x1 | 31 | -113.39 | -1.13% | -76.14 | -37.25 | 22.2% | 1.95% | -0.426 | 10.8% | 0.65 | 25.4 | inactif |
| breakout | IDENTITY | x2 | 31 | -114.25 | -1.14% | -76.69 | -37.57 | 22.2% | 1.95% | -0.429 | 10.8% | 1.29 | 25.4 | inactif |
| breakout | POWER_THIRD | x1 | 31 | -932.94 | -9.33% | -583.77 | -349.17 | 22.2% | 17.62% | -0.343 | 94.2% | 5.65 | 293.9 | non démontré |
| breakout | POWER_THIRD | x2 | 31 | -940.48 | -9.40% | -588.15 | -352.33 | 22.2% | 17.64% | -0.347 | 94.2% | 11.31 | 293.9 | non démontré |

#### BTC-USD — Y2022 · benchmark -6425.73 $ (-64.26%) · régime calculé : **BAISSIER**

| Stratégie | Calib. | Coûts | Trades | PnL net $ | Retour | Réalisé $ | Latent $ | WR liq. | DD max | Sharpe | Turnover | Frais $ | Méd. not. $ | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | IDENTITY | x1 | 33 | -4426.17 | -44.26% | 441.25 | -4867.42 | 85.7% | 49.67% | -0.815 | 162.1% | 9.73 | 503.5 | non démontré |
| rsi-reversion | IDENTITY | x2 | 33 | -4436.68 | -44.37% | 436.63 | -4873.31 | 85.7% | 49.73% | -0.818 | 162.0% | 19.44 | 503.5 | non démontré |
| rsi-reversion | POWER_THIRD | x1 | 33 | -4426.17 | -44.26% | 441.25 | -4867.42 | 85.7% | 49.67% | -0.815 | 162.1% | 9.73 | 503.5 | non démontré |
| rsi-reversion | POWER_THIRD | x2 | 33 | -4436.68 | -44.37% | 436.63 | -4873.31 | 85.7% | 49.73% | -0.818 | 162.0% | 19.44 | 503.5 | non démontré |
| ema-cross | IDENTITY | x1 | 10 | -2.99 | -0.03% | -1.48 | -1.51 | 0.0% | 0.03% | -1.575 | 0.3% | 0.02 | 3.1 | inactif |
| ema-cross | IDENTITY | x2 | 10 | -3.01 | -0.03% | -1.49 | -1.52 | 0.0% | 0.03% | -1.585 | 0.3% | 0.03 | 3.1 | inactif |
| ema-cross | POWER_THIRD | x1 | 9 | -158.38 | -1.58% | -78.12 | -80.26 | 0.0% | 1.61% | -1.837 | 11.5% | 0.69 | 145.3 | non démontré |
| ema-cross | POWER_THIRD | x2 | 9 | -159.30 | -1.59% | -78.80 | -80.50 | 0.0% | 1.62% | -1.847 | 11.5% | 1.38 | 145.3 | non démontré |
| breakout | IDENTITY | x1 | 17 | -34.47 | -0.34% | -21.89 | -12.59 | 0.0% | 0.37% | -1.930 | 2.3% | 0.14 | 21.8 | inactif |
| breakout | IDENTITY | x2 | 17 | -34.65 | -0.35% | -22.02 | -12.63 | 0.0% | 0.37% | -1.939 | 2.3% | 0.27 | 21.8 | inactif |
| breakout | POWER_THIRD | x1 | 18 | -442.70 | -4.43% | -415.71 | -27.00 | 0.0% | 4.91% | -1.826 | 40.0% | 2.40 | 279.3 | non démontré |
| breakout | POWER_THIRD | x2 | 18 | -445.90 | -4.46% | -418.66 | -27.24 | 0.0% | 4.93% | -1.839 | 40.0% | 4.80 | 279.3 | non démontré |

#### BTC-USD — Y2023 · benchmark 15559.33 $ (155.59%) · régime calculé : **HAUSSIER**

| Stratégie | Calib. | Coûts | Trades | PnL net $ | Retour | Réalisé $ | Latent $ | WR liq. | DD max | Sharpe | Turnover | Frais $ | Méd. not. $ | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | IDENTITY | x1 | 48 | 7352.99 | 73.53% | 1699.54 | 5653.44 | 100.0% | 7.56% | 2.124 | 265.5% | 15.93 | 593.2 | edge démontré |
| rsi-reversion | IDENTITY | x2 | 48 | 7331.74 | 73.32% | 1685.87 | 5645.87 | 100.0% | 7.57% | 2.117 | 265.6% | 31.87 | 593.2 | edge démontré |
| rsi-reversion | POWER_THIRD | x1 | 48 | 7352.99 | 73.53% | 1699.54 | 5653.44 | 100.0% | 7.56% | 2.124 | 265.5% | 15.93 | 593.2 | edge démontré |
| rsi-reversion | POWER_THIRD | x2 | 48 | 7331.74 | 73.32% | 1685.87 | 5645.87 | 100.0% | 7.57% | 2.117 | 265.6% | 31.87 | 593.2 | edge démontré |
| ema-cross | IDENTITY | x1 | 7 | 5.33 | 0.05% | 0.12 | 5.21 | 75.0% | 0.02% | 1.239 | 0.2% | 0.01 | 1.2 | inactif |
| ema-cross | IDENTITY | x2 | 7 | 5.32 | 0.05% | 0.11 | 5.20 | 75.0% | 0.02% | 1.236 | 0.2% | 0.02 | 1.2 | inactif |
| ema-cross | POWER_THIRD | x1 | 7 | 126.06 | 1.26% | 7.24 | 118.83 | 75.0% | 0.48% | 1.274 | 7.6% | 0.46 | 105.4 | edge démontré |
| ema-cross | POWER_THIRD | x2 | 7 | 125.46 | 1.25% | 6.81 | 118.65 | 75.0% | 0.49% | 1.268 | 7.6% | 0.91 | 105.4 | edge démontré |
| breakout | IDENTITY | x1 | 22 | 51.05 | 0.51% | -8.22 | 59.27 | 33.3% | 0.24% | 0.782 | 4.9% | 0.29 | 12.3 | inactif |
| breakout | IDENTITY | x2 | 22 | 50.66 | 0.51% | -8.38 | 59.04 | 33.3% | 0.24% | 0.777 | 4.9% | 0.58 | 12.3 | inactif |
| breakout | POWER_THIRD | x1 | 22 | 608.62 | 6.09% | -80.43 | 689.05 | 33.3% | 2.81% | 0.828 | 55.7% | 3.34 | 230.7 | edge démontré |
| breakout | POWER_THIRD | x2 | 22 | 604.17 | 6.04% | -82.40 | 686.56 | 33.3% | 2.81% | 0.822 | 55.7% | 6.68 | 230.7 | edge démontré |

#### BTC-USD — Y2024 · benchmark 12057.87 $ (120.58%) · régime calculé : **HAUSSIER**

| Stratégie | Calib. | Coûts | Trades | PnL net $ | Retour | Réalisé $ | Latent $ | WR liq. | DD max | Sharpe | Turnover | Frais $ | Méd. not. $ | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | IDENTITY | x1 | 51 | 1330.90 | 13.31% | 1316.03 | 14.87 | 100.0% | 7.65% | 0.799 | 272.7% | 16.36 | 561.9 | edge démontré |
| rsi-reversion | IDENTITY | x2 | 51 | 1309.08 | 13.09% | 1294.98 | 14.10 | 100.0% | 7.66% | 0.787 | 272.7% | 32.73 | 561.9 | edge démontré |
| rsi-reversion | POWER_THIRD | x1 | 51 | 1330.90 | 13.31% | 1316.03 | 14.87 | 100.0% | 7.65% | 0.799 | 272.7% | 16.36 | 561.9 | edge démontré |
| rsi-reversion | POWER_THIRD | x2 | 51 | 1309.08 | 13.09% | 1294.98 | 14.10 | 100.0% | 7.66% | 0.787 | 272.7% | 32.73 | 561.9 | edge démontré |
| ema-cross | IDENTITY | x1 | 9 | 4.69 | 0.05% | 1.74 | 2.95 | 100.0% | 0.02% | 1.289 | 0.2% | 0.01 | 2.0 | inactif |
| ema-cross | IDENTITY | x2 | 9 | 4.67 | 0.05% | 1.73 | 2.95 | 100.0% | 0.02% | 1.285 | 0.2% | 0.02 | 2.0 | inactif |
| ema-cross | POWER_THIRD | x1 | 10 | 130.06 | 1.30% | 83.10 | 46.97 | 66.7% | 0.63% | 1.145 | 11.9% | 0.72 | 125.3 | edge démontré |
| ema-cross | POWER_THIRD | x2 | 10 | 129.11 | 1.29% | 82.22 | 46.89 | 66.7% | 0.64% | 1.137 | 11.9% | 1.43 | 125.3 | edge démontré |
| breakout | IDENTITY | x1 | 45 | 195.79 | 1.96% | -9.20 | 204.99 | 50.0% | 1.39% | 0.725 | 9.9% | 0.59 | 15.0 | inactif |
| breakout | IDENTITY | x2 | 45 | 195.00 | 1.95% | -9.52 | 204.52 | 50.0% | 1.39% | 0.722 | 9.9% | 1.18 | 15.0 | inactif |
| breakout | POWER_THIRD | x1 | 44 | 2430.30 | 24.30% | -26.83 | 2457.13 | 50.0% | 12.83% | 0.928 | 107.9% | 6.48 | 246.5 | edge démontré |
| breakout | POWER_THIRD | x2 | 44 | 2421.66 | 24.22% | -30.31 | 2451.97 | 50.0% | 12.86% | 0.925 | 107.9% | 12.95 | 246.5 | edge démontré |

#### BTC-USD — Y2025 · benchmark -634.15 $ (-6.34%) · régime calculé : **BAISSIER**

| Stratégie | Calib. | Coûts | Trades | PnL net $ | Retour | Réalisé $ | Latent $ | WR liq. | DD max | Sharpe | Turnover | Frais $ | Méd. not. $ | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | IDENTITY | x1 | 42 | 52.63 | 0.53% | 650.07 | -597.44 | 92.3% | 8.74% | 0.087 | 216.0% | 12.96 | 509.4 | edge démontré |
| rsi-reversion | IDENTITY | x2 | 42 | 35.35 | 0.35% | 639.84 | -604.49 | 92.3% | 8.77% | 0.075 | 216.0% | 25.93 | 509.4 | edge démontré |
| rsi-reversion | POWER_THIRD | x1 | 42 | 52.63 | 0.53% | 650.07 | -597.44 | 92.3% | 8.74% | 0.087 | 216.0% | 12.96 | 509.4 | edge démontré |
| rsi-reversion | POWER_THIRD | x2 | 42 | 35.35 | 0.35% | 639.84 | -604.49 | 92.3% | 8.77% | 0.075 | 216.0% | 25.93 | 509.4 | edge démontré |
| ema-cross | IDENTITY | x1 | 5 | -0.72 | -0.01% | 0.05 | -0.77 | 50.0% | 0.01% | -0.983 | 0.0% | 0.00 | 1.8 | inactif |
| ema-cross | IDENTITY | x2 | 5 | -0.73 | -0.01% | 0.05 | -0.78 | 50.0% | 0.01% | -0.987 | 0.0% | 0.00 | 1.8 | inactif |
| ema-cross | POWER_THIRD | x1 | 7 | 5.54 | 0.06% | 8.41 | -2.87 | 50.0% | 0.31% | 0.164 | 6.8% | 0.41 | 121.3 | edge démontré |
| ema-cross | POWER_THIRD | x2 | 7 | 5.00 | 0.05% | 7.88 | -2.88 | 50.0% | 0.32% | 0.148 | 6.8% | 0.82 | 121.3 | edge démontré |
| breakout | IDENTITY | x1 | 29 | -31.62 | -0.32% | -13.42 | -18.21 | 46.2% | 0.71% | -0.511 | 3.9% | 0.23 | 8.7 | inactif |
| breakout | IDENTITY | x2 | 29 | -31.93 | -0.32% | -13.64 | -18.29 | 46.2% | 0.71% | -0.516 | 3.9% | 0.46 | 8.7 | inactif |
| breakout | POWER_THIRD | x1 | 29 | -450.49 | -4.50% | -260.48 | -190.01 | 38.5% | 8.10% | -0.637 | 61.4% | 3.69 | 205.7 | non démontré |
| breakout | POWER_THIRD | x2 | 29 | -455.40 | -4.55% | -264.68 | -190.72 | 30.8% | 8.12% | -0.644 | 61.4% | 7.37 | 205.7 | non démontré |

#### BTC-USD — Y2026 · benchmark -719.89 $ (-7.20%) · régime calculé : **BAISSIER**

| Stratégie | Calib. | Coûts | Trades | PnL net $ | Retour | Réalisé $ | Latent $ | WR liq. | DD max | Sharpe | Turnover | Frais $ | Méd. not. $ | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | IDENTITY | x1 | 33 | 1726.63 | 17.27% | 88.07 | 1638.56 | 77.8% | 20.82% | 0.717 | 180.6% | 10.84 | 557.9 | edge démontré |
| rsi-reversion | IDENTITY | x2 | 33 | 1707.36 | 17.07% | 81.68 | 1625.68 | 77.8% | 20.87% | 0.711 | 180.5% | 21.66 | 557.9 | edge démontré |
| rsi-reversion | POWER_THIRD | x1 | 33 | 1726.63 | 17.27% | 88.07 | 1638.56 | 77.8% | 20.82% | 0.717 | 180.6% | 10.84 | 557.9 | edge démontré |
| rsi-reversion | POWER_THIRD | x2 | 33 | 1707.36 | 17.07% | 81.68 | 1625.68 | 77.8% | 20.87% | 0.711 | 180.5% | 21.66 | 557.9 | edge démontré |
| ema-cross | IDENTITY | x1 | 10 | 1.34 | 0.01% | -0.16 | 1.49 | 33.3% | 0.01% | 0.973 | 0.1% | 0.01 | 0.7 | inactif |
| ema-cross | IDENTITY | x2 | 10 | 1.33 | 0.01% | -0.16 | 1.49 | 33.3% | 0.01% | 0.966 | 0.1% | 0.02 | 0.7 | inactif |
| ema-cross | POWER_THIRD | x1 | 11 | 25.88 | 0.26% | -17.03 | 42.91 | 33.3% | 0.47% | 0.594 | 10.3% | 0.62 | 88.6 | inactif |
| ema-cross | POWER_THIRD | x2 | 11 | 25.06 | 0.25% | -17.66 | 42.71 | 33.3% | 0.47% | 0.576 | 10.3% | 1.23 | 88.6 | inactif |
| breakout | IDENTITY | x1 | 16 | 20.79 | 0.21% | -2.38 | 23.17 | 33.3% | 0.13% | 0.980 | 2.9% | 0.17 | 12.8 | inactif |
| breakout | IDENTITY | x2 | 16 | 20.56 | 0.21% | -2.44 | 23.00 | 33.3% | 0.14% | 0.970 | 2.9% | 0.34 | 12.8 | inactif |
| breakout | POWER_THIRD | x1 | 15 | 145.92 | 1.46% | -77.42 | 223.33 | 20.0% | 2.20% | 0.679 | 37.9% | 2.28 | 233.6 | edge démontré |
| breakout | POWER_THIRD | x2 | 15 | 142.88 | 1.43% | -79.11 | 221.99 | 20.0% | 2.21% | 0.665 | 38.0% | 4.55 | 233.6 | edge démontré |

#### ETH-USD — FULL · benchmark 23954.46 $ (239.54%) · régime calculé : **HAUSSIER**

| Stratégie | Calib. | Coûts | Trades | PnL net $ | Retour | Réalisé $ | Latent $ | WR liq. | DD max | Sharpe | Turnover | Frais $ | Méd. not. $ | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | IDENTITY | x1 | 78 | 13334.00 | 133.34% | 3302.02 | 10031.99 | 100.0% | 66.79% | 0.453 | 438.6% | 26.31 | 520.4 | edge démontré |
| rsi-reversion | IDENTITY | x2 | 78 | 13298.91 | 132.99% | 3277.14 | 10021.77 | 100.0% | 66.84% | 0.452 | 438.6% | 52.63 | 520.4 | edge démontré |
| rsi-reversion | POWER_THIRD | x1 | 78 | 13334.00 | 133.34% | 3302.02 | 10031.99 | 100.0% | 66.79% | 0.453 | 438.6% | 26.31 | 520.4 | edge démontré |
| rsi-reversion | POWER_THIRD | x2 | 78 | 13298.91 | 132.99% | 3277.14 | 10021.77 | 100.0% | 66.84% | 0.452 | 438.6% | 52.63 | 520.4 | edge démontré |
| ema-cross | IDENTITY | x1 | 68 | 9.03 | 0.09% | 3.05 | 5.97 | 67.6% | 0.71% | 0.045 | 2.1% | 0.13 | 2.7 | inactif |
| ema-cross | IDENTITY | x2 | 68 | 8.86 | 0.09% | 2.93 | 5.92 | 67.6% | 0.71% | 0.044 | 2.1% | 0.26 | 2.7 | inactif |
| ema-cross | POWER_THIRD | x1 | 68 | 137.24 | 1.37% | 107.96 | 29.28 | 58.8% | 10.56% | 0.061 | 91.9% | 5.51 | 138.5 | edge démontré |
| ema-cross | POWER_THIRD | x2 | 68 | 129.89 | 1.30% | 101.57 | 28.31 | 55.9% | 10.57% | 0.059 | 91.9% | 11.02 | 138.5 | edge démontré |
| breakout | IDENTITY | x1 | 202 | -556.47 | -5.56% | -532.64 | -23.83 | 41.1% | 14.02% | -0.103 | 63.5% | 3.81 | 20.9 | inactif |
| breakout | IDENTITY | x2 | 202 | -561.54 | -5.62% | -536.89 | -24.65 | 39.7% | 14.03% | -0.105 | 63.5% | 7.62 | 20.9 | inactif |
| breakout | POWER_THIRD | x1 | 144 | -1158.55 | -11.59% | -2141.05 | 982.50 | 47.5% | 60.53% | 0.159 | 420.4% | 25.22 | 275.5 | non démontré |
| breakout | POWER_THIRD | x2 | 144 | -1192.18 | -11.92% | -2170.19 | 978.01 | 45.8% | 60.65% | 0.159 | 420.4% | 50.45 | 275.5 | non démontré |

#### ETH-USD — Y2021 · benchmark 39775.19 $ (397.75%) · régime calculé : **HAUSSIER**

| Stratégie | Calib. | Coûts | Trades | PnL net $ | Retour | Réalisé $ | Latent $ | WR liq. | DD max | Sharpe | Turnover | Frais $ | Méd. not. $ | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | IDENTITY | x1 | 28 | 2037.21 | 20.37% | 1980.58 | 56.63 | 100.0% | 7.24% | 1.449 | 144.2% | 8.65 | 468.7 | edge démontré |
| rsi-reversion | IDENTITY | x2 | 28 | 2025.67 | 20.26% | 1969.18 | 56.49 | 100.0% | 7.26% | 1.441 | 144.2% | 17.31 | 468.7 | edge démontré |
| rsi-reversion | POWER_THIRD | x1 | 28 | 2037.21 | 20.37% | 1980.58 | 56.63 | 100.0% | 7.24% | 1.449 | 144.2% | 8.65 | 468.7 | edge démontré |
| rsi-reversion | POWER_THIRD | x2 | 28 | 2025.67 | 20.26% | 1969.18 | 56.49 | 100.0% | 7.26% | 1.441 | 144.2% | 17.31 | 468.7 | edge démontré |
| ema-cross | IDENTITY | x1 | 11 | 8.14 | 0.08% | 2.50 | 5.64 | 83.3% | 0.09% | 0.496 | 0.4% | 0.02 | 3.5 | inactif |
| ema-cross | IDENTITY | x2 | 11 | 8.11 | 0.08% | 2.48 | 5.63 | 83.3% | 0.09% | 0.494 | 0.4% | 0.04 | 3.5 | inactif |
| ema-cross | POWER_THIRD | x1 | 11 | 208.04 | 2.08% | 129.95 | 78.09 | 83.3% | 2.04% | 0.508 | 15.5% | 0.93 | 152.0 | edge démontré |
| ema-cross | POWER_THIRD | x2 | 11 | 206.80 | 2.07% | 129.03 | 77.76 | 83.3% | 2.04% | 0.505 | 15.5% | 1.86 | 152.0 | edge démontré |
| breakout | IDENTITY | x1 | 42 | 194.78 | 1.95% | -27.02 | 221.80 | 55.6% | 6.13% | 0.252 | 14.3% | 0.86 | 24.2 | inactif |
| breakout | IDENTITY | x2 | 42 | 193.64 | 1.94% | -27.47 | 221.11 | 55.6% | 6.13% | 0.251 | 14.3% | 1.72 | 24.2 | inactif |
| breakout | POWER_THIRD | x1 | 37 | 2348.81 | 23.49% | -16.20 | 2365.01 | 66.7% | 36.48% | 0.557 | 109.5% | 6.57 | 289.3 | edge démontré |
| breakout | POWER_THIRD | x2 | 37 | 2340.05 | 23.40% | -19.94 | 2360.00 | 66.7% | 36.50% | 0.556 | 109.5% | 13.14 | 289.3 | edge démontré |

#### ETH-USD — Y2022 · benchmark -6750.94 $ (-67.51%) · régime calculé : **BAISSIER**

| Stratégie | Calib. | Coûts | Trades | PnL net $ | Retour | Réalisé $ | Latent $ | WR liq. | DD max | Sharpe | Turnover | Frais $ | Méd. not. $ | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | IDENTITY | x1 | 27 | -1771.13 | -17.71% | 376.51 | -2147.64 | 80.0% | 44.58% | 0.037 | 146.5% | 8.79 | 507.3 | non démontré |
| rsi-reversion | IDENTITY | x2 | 27 | -1783.55 | -17.84% | 373.09 | -2156.63 | 80.0% | 44.58% | 0.035 | 146.4% | 17.57 | 507.3 | non démontré |
| rsi-reversion | POWER_THIRD | x1 | 27 | -1771.13 | -17.71% | 376.51 | -2147.64 | 80.0% | 44.58% | 0.037 | 146.5% | 8.79 | 507.3 | non démontré |
| rsi-reversion | POWER_THIRD | x2 | 27 | -1783.55 | -17.84% | 373.09 | -2156.63 | 80.0% | 44.58% | 0.035 | 146.4% | 17.57 | 507.3 | non démontré |
| ema-cross | IDENTITY | x1 | 14 | -10.70 | -0.11% | -6.04 | -4.66 | 0.0% | 0.14% | -0.871 | 0.7% | 0.04 | 3.6 | inactif |
| ema-cross | IDENTITY | x2 | 14 | -10.75 | -0.11% | -6.08 | -4.67 | 0.0% | 0.14% | -0.876 | 0.7% | 0.08 | 3.6 | inactif |
| ema-cross | POWER_THIRD | x1 | 14 | -218.72 | -2.19% | -204.03 | -14.69 | 0.0% | 2.60% | -1.101 | 21.9% | 1.31 | 153.3 | non démontré |
| ema-cross | POWER_THIRD | x2 | 14 | -220.47 | -2.20% | -205.72 | -14.75 | 0.0% | 2.60% | -1.110 | 21.9% | 2.63 | 153.3 | non démontré |
| breakout | IDENTITY | x1 | 21 | -99.98 | -1.00% | -77.70 | -22.29 | 0.0% | 1.49% | -0.787 | 6.6% | 0.40 | 25.2 | inactif |
| breakout | IDENTITY | x2 | 21 | -100.51 | -1.01% | -78.15 | -22.36 | 0.0% | 1.49% | -0.791 | 6.6% | 0.79 | 25.2 | inactif |
| breakout | POWER_THIRD | x1 | 21 | -948.49 | -9.48% | -653.43 | -295.06 | 0.0% | 11.54% | -1.025 | 61.6% | 3.69 | 293.0 | non démontré |
| breakout | POWER_THIRD | x2 | 21 | -953.42 | -9.53% | -657.36 | -296.06 | 0.0% | 11.56% | -1.031 | 61.6% | 7.39 | 293.0 | non démontré |

#### ETH-USD — Y2023 · benchmark 9069.20 $ (90.69%) · régime calculé : **HAUSSIER**

| Stratégie | Calib. | Coûts | Trades | PnL net $ | Retour | Réalisé $ | Latent $ | WR liq. | DD max | Sharpe | Turnover | Frais $ | Méd. not. $ | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | IDENTITY | x1 | 28 | 4029.03 | 40.29% | 352.40 | 3676.64 | 100.0% | 10.89% | 1.141 | 145.9% | 8.75 | 545.8 | edge démontré |
| rsi-reversion | IDENTITY | x2 | 28 | 4011.97 | 40.12% | 349.00 | 3662.97 | 100.0% | 10.90% | 1.137 | 145.8% | 17.49 | 545.8 | edge démontré |
| rsi-reversion | POWER_THIRD | x1 | 28 | 4029.03 | 40.29% | 352.40 | 3676.64 | 100.0% | 10.89% | 1.141 | 145.9% | 8.75 | 545.8 | edge démontré |
| rsi-reversion | POWER_THIRD | x2 | 28 | 4011.97 | 40.12% | 349.00 | 3662.97 | 100.0% | 10.90% | 1.137 | 145.8% | 17.49 | 545.8 | edge démontré |
| ema-cross | IDENTITY | x1 | 11 | 1.87 | 0.02% | -0.60 | 2.48 | 33.3% | 0.02% | 0.578 | 0.3% | 0.02 | 2.5 | inactif |
| ema-cross | IDENTITY | x2 | 11 | 1.85 | 0.02% | -0.62 | 2.47 | 33.3% | 0.02% | 0.572 | 0.3% | 0.03 | 2.5 | inactif |
| ema-cross | POWER_THIRD | x1 | 11 | 46.72 | 0.47% | -27.10 | 73.83 | 33.3% | 0.78% | 0.458 | 13.3% | 0.80 | 134.8 | edge démontré |
| ema-cross | POWER_THIRD | x2 | 11 | 45.66 | 0.46% | -27.96 | 73.62 | 33.3% | 0.79% | 0.448 | 13.3% | 1.60 | 134.8 | edge démontré |
| breakout | IDENTITY | x1 | 21 | 24.43 | 0.24% | -14.96 | 39.39 | 20.0% | 0.32% | 0.336 | 4.3% | 0.26 | 11.5 | inactif |
| breakout | IDENTITY | x2 | 21 | 24.08 | 0.24% | -15.07 | 39.15 | 20.0% | 0.32% | 0.332 | 4.3% | 0.52 | 11.5 | inactif |
| breakout | POWER_THIRD | x1 | 22 | 76.74 | 0.77% | -240.73 | 317.47 | 16.7% | 4.41% | 0.135 | 55.1% | 3.30 | 225.7 | edge démontré |
| breakout | POWER_THIRD | x2 | 22 | 72.33 | 0.72% | -243.03 | 315.36 | 16.7% | 4.43% | 0.129 | 55.1% | 6.61 | 225.7 | edge démontré |

#### ETH-USD — Y2024 · benchmark 4588.40 $ (45.88%) · régime calculé : **HAUSSIER**

| Stratégie | Calib. | Coûts | Trades | PnL net $ | Retour | Réalisé $ | Latent $ | WR liq. | DD max | Sharpe | Turnover | Frais $ | Méd. not. $ | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | IDENTITY | x1 | 54 | 1708.93 | 17.09% | 1631.38 | 77.56 | 100.0% | 10.74% | 0.889 | 270.0% | 16.20 | 530.7 | edge démontré |
| rsi-reversion | IDENTITY | x2 | 54 | 1687.34 | 16.87% | 1611.76 | 75.58 | 100.0% | 10.75% | 0.878 | 270.0% | 32.40 | 530.7 | edge démontré |
| rsi-reversion | POWER_THIRD | x1 | 54 | 1708.93 | 17.09% | 1631.38 | 77.56 | 100.0% | 10.74% | 0.889 | 270.0% | 16.20 | 530.7 | edge démontré |
| rsi-reversion | POWER_THIRD | x2 | 54 | 1687.34 | 16.87% | 1611.76 | 75.58 | 100.0% | 10.75% | 0.878 | 270.0% | 32.40 | 530.7 | edge démontré |
| ema-cross | IDENTITY | x1 | 13 | 1.88 | 0.02% | -0.31 | 2.19 | 57.1% | 0.05% | 0.219 | 0.4% | 0.02 | 2.5 | inactif |
| ema-cross | IDENTITY | x2 | 13 | 1.85 | 0.02% | -0.33 | 2.18 | 57.1% | 0.05% | 0.215 | 0.4% | 0.05 | 2.5 | inactif |
| ema-cross | POWER_THIRD | x1 | 14 | 24.74 | 0.25% | -10.06 | 34.80 | 50.0% | 1.33% | 0.173 | 19.5% | 1.17 | 135.5 | edge démontré |
| ema-cross | POWER_THIRD | x2 | 14 | 23.18 | 0.23% | -11.45 | 34.63 | 50.0% | 1.34% | 0.162 | 19.5% | 2.34 | 135.5 | edge démontré |
| breakout | IDENTITY | x1 | 39 | -57.76 | -0.58% | -70.34 | 12.58 | 38.5% | 1.60% | -0.335 | 10.5% | 0.63 | 21.8 | inactif |
| breakout | IDENTITY | x2 | 39 | -58.60 | -0.59% | -70.99 | 12.39 | 38.5% | 1.60% | -0.340 | 10.5% | 1.26 | 21.8 | inactif |
| breakout | POWER_THIRD | x1 | 39 | -285.90 | -2.86% | -452.12 | 166.22 | 38.5% | 15.47% | -0.071 | 108.2% | 6.49 | 279.4 | non démontré |
| breakout | POWER_THIRD | x2 | 39 | -294.56 | -2.95% | -457.97 | 163.42 | 38.5% | 15.51% | -0.076 | 108.2% | 12.99 | 279.4 | non démontré |

#### ETH-USD — Y2025 · benchmark -1099.08 $ (-10.99%) · régime calculé : **BAISSIER**

| Stratégie | Calib. | Coûts | Trades | PnL net $ | Retour | Réalisé $ | Latent $ | WR liq. | DD max | Sharpe | Turnover | Frais $ | Méd. not. $ | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | IDENTITY | x1 | 53 | -354.75 | -3.55% | -25.22 | -329.53 | 45.0% | 30.32% | 0.025 | 271.8% | 16.31 | 522.1 | non démontré |
| rsi-reversion | IDENTITY | x2 | 53 | -376.49 | -3.76% | -42.17 | -334.32 | 45.0% | 30.35% | 0.019 | 271.8% | 32.62 | 522.1 | non démontré |
| rsi-reversion | POWER_THIRD | x1 | 53 | -354.75 | -3.55% | -25.22 | -329.53 | 45.0% | 30.32% | 0.025 | 271.8% | 16.31 | 522.1 | non démontré |
| rsi-reversion | POWER_THIRD | x2 | 53 | -376.49 | -3.76% | -42.17 | -334.32 | 45.0% | 30.35% | 0.019 | 271.8% | 32.62 | 522.1 | non démontré |
| ema-cross | IDENTITY | x1 | 5 | 3.25 | 0.03% | 3.08 | 0.17 | 100.0% | 0.02% | 0.994 | 0.1% | 0.01 | 2.4 | inactif |
| ema-cross | IDENTITY | x2 | 5 | 3.24 | 0.03% | 3.07 | 0.17 | 100.0% | 0.02% | 0.992 | 0.1% | 0.01 | 2.4 | inactif |
| ema-cross | POWER_THIRD | x1 | 5 | 47.70 | 0.48% | 55.80 | -8.10 | 66.7% | 0.78% | 0.460 | 6.3% | 0.38 | 133.9 | edge démontré |
| ema-cross | POWER_THIRD | x2 | 5 | 47.20 | 0.47% | 55.36 | -8.17 | 66.7% | 0.78% | 0.455 | 6.3% | 0.76 | 133.9 | edge démontré |
| breakout | IDENTITY | x1 | 27 | 27.04 | 0.27% | 23.78 | 3.26 | 62.5% | 4.21% | 0.075 | 9.2% | 0.55 | 22.1 | inactif |
| breakout | IDENTITY | x2 | 27 | 26.31 | 0.26% | 23.48 | 2.82 | 62.5% | 4.21% | 0.073 | 9.2% | 1.11 | 22.1 | inactif |
| breakout | POWER_THIRD | x1 | 27 | -306.80 | -3.07% | 51.00 | -357.80 | 50.0% | 24.90% | -0.009 | 80.3% | 4.82 | 280.5 | non démontré |
| breakout | POWER_THIRD | x2 | 27 | -313.22 | -3.13% | 47.85 | -361.08 | 50.0% | 24.92% | -0.011 | 80.3% | 9.63 | 280.5 | non démontré |

#### ETH-USD — Y2026 · benchmark -1554.65 $ (-15.55%) · régime calculé : **BAISSIER**

| Stratégie | Calib. | Coûts | Trades | PnL net $ | Retour | Réalisé $ | Latent $ | WR liq. | DD max | Sharpe | Turnover | Frais $ | Méd. not. $ | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | IDENTITY | x1 | 33 | 2017.10 | 20.17% | 227.97 | 1789.13 | 100.0% | 31.39% | 0.664 | 162.0% | 9.72 | 527.4 | edge démontré |
| rsi-reversion | IDENTITY | x2 | 33 | 2001.04 | 20.01% | 223.18 | 1777.86 | 100.0% | 31.42% | 0.661 | 161.9% | 19.43 | 527.4 | edge démontré |
| rsi-reversion | POWER_THIRD | x1 | 33 | 2017.10 | 20.17% | 227.97 | 1789.13 | 100.0% | 31.39% | 0.664 | 162.0% | 9.72 | 527.4 | edge démontré |
| rsi-reversion | POWER_THIRD | x2 | 33 | 2001.04 | 20.01% | 223.18 | 1777.86 | 100.0% | 31.42% | 0.661 | 161.9% | 19.43 | 527.4 | edge démontré |
| ema-cross | IDENTITY | x1 | 5 | 2.12 | 0.02% | -0.08 | 2.20 | 33.3% | 0.04% | 0.488 | 0.2% | 0.01 | 3.0 | inactif |
| ema-cross | IDENTITY | x2 | 5 | 2.11 | 0.02% | -0.08 | 2.19 | 33.3% | 0.04% | 0.485 | 0.2% | 0.02 | 3.0 | inactif |
| ema-cross | POWER_THIRD | x1 | 5 | 65.57 | 0.66% | -14.75 | 80.33 | 33.3% | 0.93% | 0.611 | 6.2% | 0.37 | 144.8 | edge démontré |
| ema-cross | POWER_THIRD | x2 | 5 | 65.08 | 0.65% | -14.94 | 80.02 | 33.3% | 0.93% | 0.606 | 6.2% | 0.74 | 144.8 | edge démontré |
| breakout | IDENTITY | x1 | 12 | 23.31 | 0.23% | -7.73 | 31.04 | 16.7% | 0.19% | 0.617 | 3.9% | 0.23 | 17.3 | inactif |
| breakout | IDENTITY | x2 | 12 | 23.00 | 0.23% | -7.81 | 30.81 | 16.7% | 0.19% | 0.609 | 3.9% | 0.47 | 17.3 | inactif |
| breakout | POWER_THIRD | x1 | 11 | 144.64 | 1.45% | -78.95 | 223.59 | 20.0% | 1.13% | 0.658 | 28.9% | 1.74 | 258.8 | edge démontré |
| breakout | POWER_THIRD | x2 | 11 | 142.33 | 1.42% | -80.09 | 222.42 | 20.0% | 1.14% | 0.648 | 28.9% | 3.47 | 258.8 | edge démontré |


---

## 4. Multiplicité des tests (C4) — énoncé figé avant lecture

La grille comprend **168 cellules primaires**. Sous l'hypothèse nulle (PnL
d'espérance nulle, indépendance approximative), environ **84 cellules
affichent un PnL positif par pur hasard** et la probabilité qu'au moins une
cellule passe le criblage tend vers 1. **Les 80 cellules « edge démontré »
observées (47,6 %) sont au niveau de ce que le hasard seul produit** — et
elles ne sont de toute façon pas indépendantes : mêmes stratégies, mêmes
données, mêmes régimes partagés. Le nombre effectif de paris indépendants
est très inférieur à 168 ; les 80 positives reposent en grande partie sur
un seul fait : **être long spot dans des fenêtres haussières**.

Conséquences (figées dans le modèle §5 avant exécution, appliquées ici) :

1. l'étiquette « edge démontré » est un **criblage**, jamais un verdict
   final ;
2. **toute** candidate passe par la confirmation OOS (§6) — **aucune
   exception** ;
3. aucun seuil n'a été ajusté après lecture des résultats ;
4. aucune activation ne peut résulter de cette grille.

Corollaire mesuré : en fenêtres BAISSIER, les cellules actives ne sont
positives que 22 fois sur 72 (30,6 %), et Y2022 (BTC −64 %) perd avec
**toutes** les stratégies et les deux calibrations. En fenêtres HAUSSIER :
58/96 (60,4 %). La « réussite » des stratégies suit le marché, elle ne le
bat pas.

## 5. Classement honnête des candidates

Décompte (règles figées) :

- 80 cellules de criblage positives → **58 candidates** après déduplication
  pré-déclarée (rsi-reversion invariante par calibration) ;
- **8 rejetées immédiatement** : le contrôle nécessaire cross-actif
  (même signe de PnL sur l'autre actif, même fenêtre/config) échoue — dont
  la plus grosse cellule de la grille, `breakout|BTC-USD|FULL|POWER_THIRD`
  (+8 305,52 $, réalisé **−2 117,87 $** / latent **+10 423,39 $**, WR liq.
  37,5 %, DD 50,00 %) qui perd **−1 159 $ sur ETH-USD** dans la même
  fenêtre : un tirage spécifique à un actif, pas un edge ;
- **50 candidates en attente OOS** (annexe A).

Stratification honnête des 50 restantes (in-sample, indicatif) :

- **12 satisfont déjà les 6 seuils OOS in-sample** (annexe A, ligne à
  ligne) — toutes dans des fenêtres HAUSSIER, 10 sur 12 sont
  `rsi-reversion` (Y2021/Y2023/Y2024) ;
- les 38 autres échouent déjà in-sample sur au moins un seuil figé
  (Sharpe < 0,5 : 26 ; WR liq. < 50 % : 16 ; DD > 20 % : 12 ; trades < 20 :
  22) — leur confirmation OOS est **a priori improbable** ;
- **aucune candidate ne bat le buy-and-hold de sa fenêtre FULL** :
  rsi-reversion BTC FULL = +92,71 % contre +180,09 % pour le benchmark
  (excess contextuel **−87,4 pts**, régime HAUSSIER) ; ETH :
  +133,30 % contre +239,54 % (**−106,2 pts**) — avec un drawdown maximal de
  **66,79 %** dans les deux cas. Une confirmation OOS ne changerait rien à
  cette lecture primaire : le profil est un bêta long sous-performant, pas
  un alpha.
- `ema-cross` POWER_THIRD FULL (BTC +1 192,22 $, DD 10,37 %, Sharpe 0,376)
  est le profil le plus « sain » mesuré — il reste 8× sous le benchmark de
  la même fenêtre et échoue déjà in-sample au seuil OOS de Sharpe.

## 6. Protocole OOS successor (pré-enregistré au modèle §6)

Pour **chaque** candidate — aucune exception (C4) — la confirmation exige
**tous** les critères suivants sur la fenêtre successor figée
`[2026-09-05, 2027-09-05)` (données inexistantes au gel, ONE_DAY),
configuration **exactement** celle de la cellule :

1. PnL absolu net > 0 ;
2. Sharpe annualisé ≥ 0,5 ;
3. win rate liquidatif ≥ 50 % ;
4. drawdown maximal ≤ 20 % du capital ;
5. turnover ≥ 10 % du capital ;
6. nombre de trades ≥ 20 ;
7. médiane du notional demandé ≥ 100 $.

Un seul critère manquant ⇒ candidate **rejetée**, sans recalibrage des
seuils ; une seule fenêtre successor de rattrapage autorisée
(`[2027-09-05, 2028-09-05)`). Les contrôles immédiats (nécessaires, non
suffisants) sont déjà appliqués : cohérence de signe des bras de coûts
×1/×2 — **58/58 OK** ; cross-actif — **8 rejets** (§5). Une candidate
confirmée OOS resterait soumise à une proposition séparée (aucune
activation depuis cette campagne, C2).

## 7. Cellules informationnelles

- **funding-trend p75** (constante figée `FUNDING_TREND_ENTER_THRESHOLD`,
  re-vérifiée contre l'annexe #35, fixtures dao30/dao35 empreintes
  vérifiées, continuation préfixe 90 j + OOS 3 j) : **0 trade, PnL
  0,00 $, DD 0 %** — « 0 trade attendu » confirmé sur données réelles.
  Statut inchangé : variant in-sample non validé OOS (INV-F9). Le rejeu
  passe volontairement par le chemin de repli (les indicateurs préparés #37
  ne portent pas `fundingAvg`) : un 0 trade obtenu autrement aurait été un
  artefact de mécanique.
- **ensemble** (56 scénarios) : 41 positifs, dominé par l'exposition
  rsi-reversion — aucune lecture au-delà de l'informationnel (modèle §9,
  INV-9).

---

## 8. Vérifications

- **C1** : la grille était figée dans `models/edge-research-campaign.md`
  (+ revue) au commit `168fa80`, **avant le premier run** ; le script et ce
  rapport sont committés après exécution. Aucune cellule ajoutée, retirée
  ou re-paramétrée après coup ; aucune cellule non exécutable à consigner
  (0 échec — les 14 datasets attendus étaient complets, décomptes de
  bougies vérifiés à la volée : 2 072 / 365 / 365 / 365 / 366 / 365 / 246).
- **C2** : périmètre d'écriture = 2 fichiers de modèle, 1 script d'analyse,
  ce rapport. `git diff` de la branche : aucun fichier de `src/` de
  trading, aucune machine, aucune permission, aucune activation.
- **C3** : toutes les valeurs de ce rapport proviennent de
  `packages/backtest/.artifacts/studies/edge-grid-2026-09/grid-result.json`
  (sorties de `runBacktestSuite` + `evaluateV2` du dépôt) ; empreintes
  SHA-256 des datasets et fixtures consignées dans l'artefact.
- **Suites** : `pnpm check`, `pnpm test`, `pnpm build`, `pnpm lint` sans
  nouveau warning (les 9 warnings lint préexistants sont inchangés).

## 9. Points ouverts

1. **50 candidates en attente OOS** : la fenêtre successor
   `[2026-09-05, 2027-09-05)` n'existera qu'à partir du 2026-09-05 ; le
   protocole figé est prêt, aucune donnée n'est devinable avant.
2. **Le verrou réel n'est pas la sélection, c'est le profil** : même
   confirmée, la meilleure candidate reste un bêta long avec excess
   négatif vs buy-and-hold et DD jusqu'à 66,79 % — le problème de
   sous-exposition/structure documenté le 2026-09-04 n'est pas résolu par
   la grille, il est désormais mesuré à l'échelle de 5 ans.
3. **Sous IDENTITY, ema-cross et breakout sont structurellement inactifs**
   (médianes de notional demandé 0,8–31 $ pour 1 000 $ cibles) : la grille
   ne les teste pratiquement pas sous cette calibration — constat confirmé
   à l'échelle 5 ans.
4. **Y2026 est partielle** (246 bougies, dernier jour clôturé 2026-09-03) :
   verdicts valides, comparabilité limitée.
5. **BTC et ETH sont corrélés** : le contrôle cross-actif est faible (même
   régime dominant) ; seul l'OOS temporel décide.
6. La grille est spot long-only : aucune lecture short/perp n'est possible
   (funding-trend reste informationnel, INV-F9 inchangé).

---

## Annexe A — Candidates dédupliquées (58) et contrôles immédiats

« Statut » : REJETÉE = contrôle nécessaire cross-actif non passé (même
fenêtre, même config, autre actif, signe de PnL opposé) ; EN ATTENTE OOS =
soumise au protocole §6 sur `[2026-09-05, 2027-09-05)`. Les seuils OOS
in-sample (colonnes Sharpe / WR liq. / DD) sont rappelés pour la
stratification honnête du §5 — un échec in-sample rend la confirmation
a priori improbable sans préjuger du verdict OOS.

| Candidate (clé figée) | PnL $ | Sharpe | WR liq. | DD max | Contrôle coûts (×1/×2) | Contrôle cross-actif | Statut |
|---|---|---|---|---|---|---|---|
| `breakout|BTC-USD|FULL|POWER_THIRD|x1` | 8305.52 | 0.409 | 37.5% | 50.00% | ✓ même signe | ✗ (ETH-USD -1159 $) | REJETÉE (cross-actif) |
| `breakout|BTC-USD|FULL|POWER_THIRD|x2` | 8284.61 | 0.408 | 37.5% | 50.03% | ✓ même signe | ✗ (ETH-USD -1192 $) | REJETÉE (cross-actif) |
| `breakout|BTC-USD|Y2023|POWER_THIRD|x1` | 608.62 | 0.828 | 33.3% | 2.81% | ✓ même signe | ✓ (ETH-USD +77 $) | EN ATTENTE OOS |
| `breakout|BTC-USD|Y2023|POWER_THIRD|x2` | 604.17 | 0.822 | 33.3% | 2.81% | ✓ même signe | ✓ (ETH-USD +72 $) | EN ATTENTE OOS |
| `breakout|BTC-USD|Y2024|POWER_THIRD|x1` | 2430.30 | 0.928 | 50.0% | 12.83% | ✓ même signe | ✗ (ETH-USD -286 $) | REJETÉE (cross-actif) |
| `breakout|BTC-USD|Y2024|POWER_THIRD|x2` | 2421.66 | 0.925 | 50.0% | 12.86% | ✓ même signe | ✗ (ETH-USD -295 $) | REJETÉE (cross-actif) |
| `breakout|BTC-USD|Y2026|POWER_THIRD|x1` | 145.92 | 0.679 | 20.0% | 2.20% | ✓ même signe | ✓ (ETH-USD +145 $) | EN ATTENTE OOS |
| `breakout|BTC-USD|Y2026|POWER_THIRD|x2` | 142.88 | 0.665 | 20.0% | 2.21% | ✓ même signe | ✓ (ETH-USD +142 $) | EN ATTENTE OOS |
| `breakout|ETH-USD|Y2021|POWER_THIRD|x1` | 2348.81 | 0.557 | 66.7% | 36.48% | ✓ même signe | ✗ (BTC-USD -933 $) | REJETÉE (cross-actif) |
| `breakout|ETH-USD|Y2021|POWER_THIRD|x2` | 2340.05 | 0.556 | 66.7% | 36.50% | ✓ même signe | ✗ (BTC-USD -940 $) | REJETÉE (cross-actif) |
| `breakout|ETH-USD|Y2023|POWER_THIRD|x1` | 76.74 | 0.135 | 16.7% | 4.41% | ✓ même signe | ✓ (BTC-USD +609 $) | EN ATTENTE OOS |
| `breakout|ETH-USD|Y2023|POWER_THIRD|x2` | 72.33 | 0.129 | 16.7% | 4.43% | ✓ même signe | ✓ (BTC-USD +604 $) | EN ATTENTE OOS |
| `breakout|ETH-USD|Y2026|POWER_THIRD|x1` | 144.64 | 0.658 | 20.0% | 1.13% | ✓ même signe | ✓ (BTC-USD +146 $) | EN ATTENTE OOS |
| `breakout|ETH-USD|Y2026|POWER_THIRD|x2` | 142.33 | 0.648 | 20.0% | 1.14% | ✓ même signe | ✓ (BTC-USD +143 $) | EN ATTENTE OOS |
| `ema-cross|BTC-USD|FULL|POWER_THIRD|x1` | 1192.22 | 0.376 | 83.3% | 10.37% | ✓ même signe | ✓ (ETH-USD +137 $) | EN ATTENTE OOS |
| `ema-cross|BTC-USD|FULL|POWER_THIRD|x2` | 1186.55 | 0.375 | 83.3% | 10.38% | ✓ même signe | ✓ (ETH-USD +130 $) | EN ATTENTE OOS |
| `ema-cross|BTC-USD|Y2021|POWER_THIRD|x1` | 22.65 | 0.200 | 40.0% | 0.68% | ✓ même signe | ✓ (ETH-USD +208 $) | EN ATTENTE OOS |
| `ema-cross|BTC-USD|Y2021|POWER_THIRD|x2` | 21.70 | 0.192 | 40.0% | 0.68% | ✓ même signe | ✓ (ETH-USD +207 $) | EN ATTENTE OOS |
| `ema-cross|BTC-USD|Y2023|POWER_THIRD|x1` | 126.06 | 1.274 | 75.0% | 0.48% | ✓ même signe | ✓ (ETH-USD +47 $) | EN ATTENTE OOS |
| `ema-cross|BTC-USD|Y2023|POWER_THIRD|x2` | 125.46 | 1.268 | 75.0% | 0.49% | ✓ même signe | ✓ (ETH-USD +46 $) | EN ATTENTE OOS |
| `ema-cross|BTC-USD|Y2024|POWER_THIRD|x1` | 130.06 | 1.145 | 66.7% | 0.63% | ✓ même signe | ✓ (ETH-USD +25 $) | EN ATTENTE OOS |
| `ema-cross|BTC-USD|Y2024|POWER_THIRD|x2` | 129.11 | 1.137 | 66.7% | 0.64% | ✓ même signe | ✓ (ETH-USD +23 $) | EN ATTENTE OOS |
| `ema-cross|BTC-USD|Y2025|POWER_THIRD|x1` | 5.54 | 0.164 | 50.0% | 0.31% | ✓ même signe | ✓ (ETH-USD +48 $) | EN ATTENTE OOS |
| `ema-cross|BTC-USD|Y2025|POWER_THIRD|x2` | 5.00 | 0.148 | 50.0% | 0.32% | ✓ même signe | ✓ (ETH-USD +47 $) | EN ATTENTE OOS |
| `ema-cross|ETH-USD|FULL|POWER_THIRD|x1` | 137.24 | 0.061 | 58.8% | 10.56% | ✓ même signe | ✓ (BTC-USD +1192 $) | EN ATTENTE OOS |
| `ema-cross|ETH-USD|FULL|POWER_THIRD|x2` | 129.89 | 0.059 | 55.9% | 10.57% | ✓ même signe | ✓ (BTC-USD +1187 $) | EN ATTENTE OOS |
| `ema-cross|ETH-USD|Y2021|POWER_THIRD|x1` | 208.04 | 0.508 | 83.3% | 2.04% | ✓ même signe | ✓ (BTC-USD +23 $) | EN ATTENTE OOS |
| `ema-cross|ETH-USD|Y2021|POWER_THIRD|x2` | 206.80 | 0.505 | 83.3% | 2.04% | ✓ même signe | ✓ (BTC-USD +22 $) | EN ATTENTE OOS |
| `ema-cross|ETH-USD|Y2023|POWER_THIRD|x1` | 46.72 | 0.458 | 33.3% | 0.78% | ✓ même signe | ✓ (BTC-USD +126 $) | EN ATTENTE OOS |
| `ema-cross|ETH-USD|Y2023|POWER_THIRD|x2` | 45.66 | 0.448 | 33.3% | 0.79% | ✓ même signe | ✓ (BTC-USD +125 $) | EN ATTENTE OOS |
| `ema-cross|ETH-USD|Y2024|POWER_THIRD|x1` | 24.74 | 0.173 | 50.0% | 1.33% | ✓ même signe | ✓ (BTC-USD +130 $) | EN ATTENTE OOS |
| `ema-cross|ETH-USD|Y2024|POWER_THIRD|x2` | 23.18 | 0.162 | 50.0% | 1.34% | ✓ même signe | ✓ (BTC-USD +129 $) | EN ATTENTE OOS |
| `ema-cross|ETH-USD|Y2025|POWER_THIRD|x1` | 47.70 | 0.460 | 66.7% | 0.78% | ✓ même signe | ✓ (BTC-USD +6 $) | EN ATTENTE OOS |
| `ema-cross|ETH-USD|Y2025|POWER_THIRD|x2` | 47.20 | 0.455 | 66.7% | 0.78% | ✓ même signe | ✓ (BTC-USD +5 $) | EN ATTENTE OOS |
| `ema-cross|ETH-USD|Y2026|POWER_THIRD|x1` | 65.57 | 0.611 | 33.3% | 0.93% | ✓ même signe | ✓ (BTC-USD +26 $) | EN ATTENTE OOS |
| `ema-cross|ETH-USD|Y2026|POWER_THIRD|x2` | 65.08 | 0.606 | 33.3% | 0.93% | ✓ même signe | ✓ (BTC-USD +25 $) | EN ATTENTE OOS |
| `rsi-reversion|BTC-USD|FULL|x1` | 9270.82 | 0.400 | 94.1% | 66.79% | ✓ même signe | ✓ (ETH-USD +13334 $) | EN ATTENTE OOS |
| `rsi-reversion|BTC-USD|FULL|x2` | 9222.64 | 0.399 | 94.1% | 66.79% | ✓ même signe | ✓ (ETH-USD +13299 $) | EN ATTENTE OOS |
| `rsi-reversion|BTC-USD|Y2021|x1` | 161.01 | 0.157 | 88.2% | 19.17% | ✓ même signe | ✓ (ETH-USD +2037 $) | EN ATTENTE OOS |
| `rsi-reversion|BTC-USD|Y2021|x2` | 144.30 | 0.152 | 88.2% | 19.21% | ✓ même signe | ✓ (ETH-USD +2026 $) | EN ATTENTE OOS |
| `rsi-reversion|BTC-USD|Y2023|x1` | 7352.99 | 2.124 | 100.0% | 7.56% | ✓ même signe | ✓ (ETH-USD +4029 $) | EN ATTENTE OOS |
| `rsi-reversion|BTC-USD|Y2023|x2` | 7331.74 | 2.117 | 100.0% | 7.57% | ✓ même signe | ✓ (ETH-USD +4012 $) | EN ATTENTE OOS |
| `rsi-reversion|BTC-USD|Y2024|x1` | 1330.90 | 0.799 | 100.0% | 7.65% | ✓ même signe | ✓ (ETH-USD +1709 $) | EN ATTENTE OOS |
| `rsi-reversion|BTC-USD|Y2024|x2` | 1309.08 | 0.787 | 100.0% | 7.66% | ✓ même signe | ✓ (ETH-USD +1687 $) | EN ATTENTE OOS |
| `rsi-reversion|BTC-USD|Y2025|x1` | 52.63 | 0.087 | 92.3% | 8.74% | ✓ même signe | ✗ (ETH-USD -355 $) | REJETÉE (cross-actif) |
| `rsi-reversion|BTC-USD|Y2025|x2` | 35.35 | 0.075 | 92.3% | 8.77% | ✓ même signe | ✗ (ETH-USD -376 $) | REJETÉE (cross-actif) |
| `rsi-reversion|BTC-USD|Y2026|x1` | 1726.63 | 0.717 | 77.8% | 20.82% | ✓ même signe | ✓ (ETH-USD +2017 $) | EN ATTENTE OOS |
| `rsi-reversion|BTC-USD|Y2026|x2` | 1707.36 | 0.711 | 77.8% | 20.87% | ✓ même signe | ✓ (ETH-USD +2001 $) | EN ATTENTE OOS |
| `rsi-reversion|ETH-USD|FULL|x1` | 13334.00 | 0.453 | 100.0% | 66.79% | ✓ même signe | ✓ (BTC-USD +9271 $) | EN ATTENTE OOS |
| `rsi-reversion|ETH-USD|FULL|x2` | 13298.91 | 0.452 | 100.0% | 66.84% | ✓ même signe | ✓ (BTC-USD +9223 $) | EN ATTENTE OOS |
| `rsi-reversion|ETH-USD|Y2021|x1` | 2037.21 | 1.449 | 100.0% | 7.24% | ✓ même signe | ✓ (BTC-USD +161 $) | EN ATTENTE OOS |
| `rsi-reversion|ETH-USD|Y2021|x2` | 2025.67 | 1.441 | 100.0% | 7.26% | ✓ même signe | ✓ (BTC-USD +144 $) | EN ATTENTE OOS |
| `rsi-reversion|ETH-USD|Y2023|x1` | 4029.03 | 1.141 | 100.0% | 10.89% | ✓ même signe | ✓ (BTC-USD +7353 $) | EN ATTENTE OOS |
| `rsi-reversion|ETH-USD|Y2023|x2` | 4011.97 | 1.137 | 100.0% | 10.90% | ✓ même signe | ✓ (BTC-USD +7332 $) | EN ATTENTE OOS |
| `rsi-reversion|ETH-USD|Y2024|x1` | 1708.93 | 0.889 | 100.0% | 10.74% | ✓ même signe | ✓ (BTC-USD +1331 $) | EN ATTENTE OOS |
| `rsi-reversion|ETH-USD|Y2024|x2` | 1687.34 | 0.878 | 100.0% | 10.75% | ✓ même signe | ✓ (BTC-USD +1309 $) | EN ATTENTE OOS |
| `rsi-reversion|ETH-USD|Y2026|x1` | 2017.10 | 0.664 | 100.0% | 31.39% | ✓ même signe | ✓ (BTC-USD +1727 $) | EN ATTENTE OOS |
| `rsi-reversion|ETH-USD|Y2026|x2` | 2001.04 | 0.661 | 100.0% | 31.42% | ✓ même signe | ✓ (BTC-USD +1707 $) | EN ATTENTE OOS |

## Annexe B — Reproductibilité

```bash
# Grille complète (~46 min, fetch Coinbase réel) :
pnpm --filter @dodash/backtest build
pnpm dlx tsx packages/backtest/scripts/edge-research-grid.ts
# Artefacts (hors dépôt) :
#   packages/backtest/.artifacts/studies/edge-grid-2026-09/
#     grid-result.json        — consolidé (56 runs, 168 cellules + info)
#     run--<actif>--<fenêtre>--<calib>--<coûts>.json
#     funding-trend-p75.json
# Reprise : artefact de run existant => rechargé, jamais rejoué.
```

Rapport généré à partir de la sortie réelle du 2026-09-04 ; aucun chiffre
inventé, aucun échec substitué (0 échec). Aucune stratégie activée, aucun
push effectué, brief non committé.
