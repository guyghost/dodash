# ANALYSE-BACKTEST — Edge des stratégies dodash

**Date** : 2026-09-04 · **Environnement** : node v22.23.1, pnpm 11.23.0 · **Honnêteté first** : tous les chiffres ci-dessous sont des sorties réelles des outils du dépôt (reproductibles via les commandes indiquées). Aucun chiffre n'est inventé ni extrapolé. Aucune modification de code métier n'a été faite (un script d'analyse non commité a été ajouté : `analysis-fee-sensitivity.mjs`).

---

## 0. Ce qui a tourné et ce qui a échoué

| Outil | Commande | Statut |
|---|---|---|
| Backtest principal | `node dist/cli.js --product BTC-USD --timeframe ONE_DAY --start 2025-09-01 --end 2026-09-01` | ✅ OK (fetch réseau Coinbase réel, 73 s) |
| Backtest 5 ans (2021→2026) | même commande, `--start 2021-09-01 --end 2026-09-04` | ❌ **Échec consigné** : timeout > 300 s (la préparation d'indicateurs ne tient pas > ~365 bougies journalières dans la timebox). Fenêtre retenue = celle des fixtures. |
| Study calibration | `pnpm --filter @dodash/backtest study:confidence-calibration` | ✅ OK (8 runs : ETC/ATOM × 4 folds, ~25 min) |
| Study confirmation | `pnpm --filter @dodash/backtest study:confidence-confirmation` | ✅ OK (ALGO/FIL × 4 folds, verdict `CONFIRMED`) — voir §3 bis |
| Study sample-size audit | `pnpm --filter @dodash/backtest study:confidence-quantile-sample-size` | ❌ **Échec consigné** : `ENOENT` — dépend de l'artefact `confidence-quantile-sensitivity-XTZ-ZEC-GRT-MANA-2022-2026.json` (16 runs, non produit, hors timebox) |
| Walk-forward funding | `pnpm dlx tsx packages/backtest/scripts/funding-edge-walkforward.ts` | ✅ OK (fixtures dao30, empreintes SHA-256 vérifiées par le script) |
| Sensibilité frais | `node analysis-fee-sensitivity.mjs` (racine, non commité) | ✅ OK (même dataset que le principal) |

**Dataset principal** (identique empreinte à la fixture dao30, cohérence vérifiée) :
`coinbase:BTC-USD:ONE_DAY:1756684800000:1788220800000:2b8ea24b…1930` — 365 bougies journalières, 2025-09-01 → 2026-09-01, prix réels Coinbase.

**Config défauts du dépôt** (`src/cli.ts`) : capital 10 000 $, notional signal 1 000 $, SL 150 bps / TP 300 bps, frais 6 bps + slippage 2 bps, exécution `NEXT_CANDLE_OPEN`, spot long-only, calibration `IDENTITY`, indicateurs par défaut.

---

## 1. Backtest principal — BTC-USD, 365 jours (fenêtre fixtures dao30)

**Benchmark buy-and-hold : −27,48 %** (PnL −2 748,14 $). L'année fenêtrée est un marché baissier pour BTC.

| Stratégie | Trades | PnL net | Rendement | Excess vs bench | Win rate* | Win rate liq. | Profit factor | Sharpe (√252) | Max drawdown | Turnover | Frais payés |
|---|---|---|---|---|---|---|---|---|---|---|---|
| rsi-reversion | 29 | **−1 024,69 $** | −10,25 % | +17,23 pts | 100 % | 83,33 % | n/a | **−0,075** | **35,02 %** | 149,2 % | 8,95 $ |
| ema-cross | 13 | **+0,49 $** | +0,00 % | +27,49 pts | 0 % | 14,29 % | 0,00 | +0,245 | 0,02 % | 0,2 % | 0,01 $ |
| breakout | 28 | **−4,57 $** | −0,05 % | +27,44 pts | 0 % | 9,09 % | 0,00 | −0,208 | 0,21 % | 4,4 % | 0,26 $ |
| ensemble (3 legacy) | 38 | **−1 021,96 $** | −10,22 % | +17,26 pts | 55,56 % | 50,00 % | 20,01 | −0,075 | 34,95 % | 149,1 % | 8,94 $ |

\* Le win rate comptabilise **uniquement les trades clôturés**. Pour rsi-reversion : réalisé +45,16 $ mais **latent −1 069,85 $** (position ouverte en fin de fenêtre, marquée au dernier close). Le win rate « liquidatif » (INV-26) corrige en partie ce biais : 83,33 %.

**Lecture honnête :**
- **rsi-reversion** perd −10,25 % en net. Son « excess +17 pts » ne signifie rien d'autre que « perdre moins que le benchmark dans un marché −27 % ». Le drawdown de 35 % sur 10 k$ de capital pour 1 000 $ de notional signal traduit une exposition cumulée importante (149 % de turnover).
- **ema-cross et breakout sont quasi inactifs sous calibration IDENTITY** : notional demandé médian de **0,77 $** (ema-cross) et **10,61 $** (breakout) pour 1 000 $ cibles — turnover de 0,2 % et 4,4 %. Leur PnL ≈ 0 et Sharpe « positif » sont des **artefacts d'absence d'exposition**, pas un edge. Le diagnostic interne le confirme : 15/338 et 35/338 signaux actifs, confiances médianes 0,077 % et 1,06 %.
- **ensemble** est dominé par rsi-reversion (le seul à exposer réellement le capital).

### Verdict par stratégie (fenêtre principale)

| Stratégie | Verdict | Justification (chiffres) |
|---|---|---|
| rsi-reversion | **Edge non démontré** | PnL net négatif (−1 024,69 $), Sharpe négatif (−0,075), drawdown 35 %. Gagne sur les trades clôturés (+45 $) mais détruit la performance en position latente. |
| ema-cross | **Insuffisant en données d'activité** | Exposition quasi nulle (notional médian 0,77 $) : le résultat (+0,49 $) ne teste pas la stratégie, il teste l'absence de trading. |
| breakout | **Insuffisant en données d'activité** | Idem (notional médian 10,61 $, PnL −4,57 $). |
| ensemble | **Edge non démontré** | Hérite du PnL négatif de rsi-reversion (−1 021,96 $). |
| funding-trend | **Edge non démontré** | Voir §3 — 0 trade sur H12, seuils S1/S2/S4 non satisfaits. |

---

## 2. Mission 2 — Étude de calibration walk-forward (`study:confidence-calibration`)

Artefact : `packages/backtest/.artifacts/studies/confidence-calibration-ETC-ATOM-2022-2026.json` — **statut `RESEARCH_ONLY`**. Protocole : profils IDENTITY / POWER_HALF / POWER_THIRD / POWER_QUARTER, sélection sur folds dev 2022-2025 (2 produits), holdout 2025-2026 chargé après sélection, **PnL explicitement exclu du classement** (`pnlUsedForRanking: false` — la sélection porte sur l'éligibilité d'exposition).

**Sélection : `POWER_THIRD`** (seul éligible avec POWER_QUARTER ; médianes de notional demandé remontées de 2,18 $ → 129,57 $ pour ema-cross et 19,49 $ → 269,04 $ pour breakout).

**Conclusions du holdout (2025-2026, avec exits protecteurs 150/300 et exécution 6 h — config propre à l'étude) :**

| Produit (benchmark) | rsi-reversion | ema-cross | breakout | ensemble |
|---|---|---|---|---|
| ETC-USD (−71,79 %) | −2,67 % (Sharpe −2,39, 113 trades) | −0,03 % | −0,17 % | −2,61 % |
| ATOM-USD (−68,40 %) | −1,43 % (Sharpe −0,99, 167 trades) | −0,02 % | **+0,13 %** (18 trades) | −1,09 % |

- Sur le holdout, **toutes les scénarios sont perdants en absolu** sauf breakout sur ATOM (+0,13 %, 18 trades — non significatif).
- Folds dev (POWER_THIRD, 6 runs) : PnL cumulé négatif pour toutes — rsi −313,17 $, breakout −120,10 $, ema-cross −29,89 $, ensemble −332,62 $.
- Même en corrigeant la sous-exposition (POWER_THIRD), **aucun edge n'apparaît** : les pertes sont plus petites que le benchmark mais restent des pertes.

### §3 bis — Study confirmation (`study:confidence-confirmation`, ALGO/FIL × 4 folds)

Artefact : `packages/backtest/.artifacts/studies/confidence-calibration-confirmation-ALGO-FIL-2022-2026.json` — **statut `RESEARCH_ONLY`, verdict `CONFIRMED`**. Attention à la portée : le verdict confirme **le comportement d'exposition** du profil gelé POWER_THIRD (notional demandé médian ema-cross 139,58 $ / breakout 302,97 $, dans la bande requise [100 ; 400] $ sur 100 % des runs, drawdown max 0,61 %, turnover max 1,65, taux de frais max 0,099 % — tous sous les plafonds), **pas la rentabilité** : `pnlUsedForVerdict: false`.

PnL par fold (POWER_THIRD, benchmark entre parenthèses) :

| Fold | ALGO-USD | FIL-USD |
|---|---|---|
| 2022-2023 | rsi −4,08 % (bench −71,4 %) · breakout +0,06 % | rsi −2,04 % (bench −53,3 %) · breakout −0,42 % |
| 2023-2024 | rsi −0,24 % (bench **+24,4 %**) · breakout −0,53 % | rsi −0,73 % (bench +1,3 %) · breakout −0,04 % |
| 2024-2025 | rsi +0,27 % (bench **+115,0 %**) · breakout −0,21 % | rsi +0,38 % (bench −30,5 %) · breakout −0,26 % |
| 2025-2026 | rsi +0,45 % (bench −69,5 %) · breakout −0,42 % | rsi −0,72 % (bench −74,5 %) · breakout −0,29 % |

**Conclusions** : (1) la confirmation valide l'outil de calibration, pas un edge ; (2) les PnL absolus restent majoritairement négatifs et toujours minuscules face au benchmark — sur ALGO 2024-2025, le benchmark fait +115 % pendant que le meilleur scénario fait +0,41 % : la sous-exposition chronique fait rater les marchés haussiers autant qu'elle « protège » dans les baissiers. Aucun des 32 scénarios POWER_THIRD ne dépasse +0,45 % sur un an.

---

## 3. Mission 3 — Walk-forward funding-trend (fixtures dao30 réelles)

Sortie complète : `/tmp/dao-analysis/funding-walkforward.json`. Protocole `models/funding-edge-campaign.md`, config figée (§4), fenêtre H12 = 2025-09-01 → 2026-09-01 + 4 trimestres + R30, prix Coinbase + funding Hyperliquid (8 760 échantillons horaires, empreintes vérifiées).

**Résultat funding-trend sur H12 : 0 trade, PnL 0,00 $, Sharpe 0, turnover 0.**

| Seuil protocole | Valeur mesurée | Verdict |
|---|---|---|
| S1 edge net : Sharpe(funding) ≥ Sharpe(baseline max) + 0,25 | −0,2415 (vs ema-cross 0,2415) | ❌ |
| S2 activité : trades ≥ 30 | **0** | ❌ |
| S3 risque : drawdown ≤ baseline + 5 pts | −0,3506 (triviallement vrai, 0 trade) | ✅ (non informatif) |
| S4 stabilité : ≥ 3/4 trimestres ≥ 0 ET R30 ≥ 0 | F1, F2 seuls positifs ; R30 = −4,64 | ❌ |
| S5 non destructif : Sharpe ≥ 0 | 0 (triviallement vrai) | ✅ (non informatif) |

**Verdict du protocole confirmé : edge non démontré.** Explication par les données réelles de la fixture : le seuil d'entrée de la stratégie est |funding| ≥ 5×10⁻⁵ par heure ; sur les 8 760 échantillons, **seuls 0,05 % des taux atteignent ce seuil** (médiane 1,25×10⁻⁵, max 23,27×10⁻⁵). La stratégie n'a littéralement jamais tradé sur la fenêtre. La stratégie n'est pas « rentable » ni « perdante » : elle est **inopérante sur des données réelles 2025-2026**.

Pour référence, le même replay sur les 3 legacy confirme la fenêtre : rsi −10,38 % (30 trades), ema-cross +0,005 %, breakout −0,046 %, benchmark −27,48 % — cohérent avec le backtest principal.

---

## 4. Mission 4 — Sensibilité aux frais (frais ×1,5 et ×2)

Même dataset, même config que le principal ; seul `broker` varie (script `analysis-fee-sensitivity.mjs`, sortie `/tmp/dao-analysis/fee-sensitivity.json`).

| PnL net | ×1,0 (6/2 bps) | ×1,5 (9/3 bps) | ×2,0 (12/4 bps) | Δ ×1→×2 |
|---|---|---|---|---|
| rsi-reversion | −1 024,69 $ | −1 030,88 $ | −1 037,07 $ | **−12,38 $** (−0,12 % capital) |
| ema-cross | +0,49 $ | +0,48 $ | +0,47 $ | −0,02 $ |
| breakout | −4,57 $ | −4,75 $ | −4,92 $ | −0,35 $ |
| ensemble | −1 021,96 $ | −1 028,15 $ | −1 034,33 $ | −12,37 $ |

**Fragilité aux coûts de transaction : FAIBLE en l'état.** Doubler les coûts aggrave la perte de rsi-reversion de 12,38 $ sur 1 024,69 $ (~1,2 % de la perte). La perte vient de **l'exposition au marché** (latent −1 069,85 $), pas des frais (8,95 $ → 17,90 $). Nuance importante : ema-cross/breakout ne sont pas fee-fragiles *parce qu'ils ne tradent pas* ; si la calibration POWER_THIRD était activée pour restaurer l'exposition, leur turnover monterait (~1,14 max mesuré en dev) mais le taux de frais mesuré resterait faible (max 0,069 % du capital sur les folds dev). **Le point de fragilité réel de ces stratégies est le marché, pas les coûts.**

---

## 5. Limites méthodologiques (listées honnêtement)

1. **Fenêtre unique et baissière** : le backtest principal couvre 365 jours de marché BTC −27,48 %. Aucune conclusion possible sur les années haussières ; l'« excess return » positif est un artefact du benchmark baissier.
2. **Single asset** : une seule paire (BTC-USD) pour le run principal ; ETC/ATOM en étude seulement. Aucune preuve de généralisation.
3. **Fenêtre longue inatteignable avec l'outillage actuel** : le run 5 ans a timeouté (préparation d'indicateurs). Conséquence : pas de test multi-régimes sur le runner principal.
4. **Biais de sélection préalable** : les paramètres (RSI 30/70, lookback 20, EMA défauts, seuil funding 5×10⁻⁵) sont des défauts du dépôt hérités de campagnes internes antérieures — un biais de survivance sur leurs propres données ne peut être exclu.
5. **Win rate trompeur** : compté sur trades clôturés seulement (rsi : 100 % clôturé vs 83,33 % liquidatif, latent −1 069,85 $).
6. **Sharpe** annualisé √252 sur courbe d'équité journalière, avec 13–38 trades seulement : intervalles de confiance énormes, aucune significativité statistique revendicable.
7. **Funding Hyperliquid projeté sur prix spot Coinbase** : le funding perp d'une autre venue n'est qu'un proxy du coût de carry réel.
8. **Étude calibration** : config différente du run principal (exits protecteurs, exécution 6 h), statut `RESEARCH_ONLY`, holdout unique d'un an.
9. **Look-ahead** : exécution `NEXT_CANDLE_OPEN` (conception anti look-ahead du dépôt) ; les indicateurs sont causaux. Non audité ligne à ligne dans le cadre de cette mission — propriété de conception, pas un résultat vérifié ici.
10. **Pas de vente à découvert** : spot long-only ; dans un marché baissier, la meilleure stratégie « testée » est celle qui ne trade pas.

---

## 6. Conclusion — ces stratégies peuvent-elles rapporter en l'état ?

**Non — pas de preuve d'edge en l'état.**

Raisonnement, appuyé uniquement sur les sorties ci-dessus :

1. **En absolu, aucune stratégie ne gagne de manière crédible** : sur la fenêtre principale, rsi-reversion perd −10,25 %, ensemble −10,22 %, breakout −0,05 % ; seul ema-cross affiche +0,49 $ — mais avec 13 trades de notional médian 0,77 $, c'est un artefact d'inactivité, pas une performance.
2. **La seule « surperformance » mesurée (+17 à +27 pts d'excess) est mécanique** : perdre moins qu'un benchmark à −27 % n'est pas un edge, c'est une sous-exposition dans un marché baissier.
3. **La cross-validation indépendante confirme** : holdout ETC/ATOM de l'étude de calibration — toutes scénarios perdants en absolu (sauf +0,13 % non significatif) ; walk-forward funding — funding-trend inopérant (0 trade, seuil jamais atteint sur données réelles), S1/S2/S4 échoués.
4. **Les coûts ne sont pas la cause du problème** (fragilité ×2 = −12,38 $ sur −1 024,69 $) : les améliorer n'inverserait aucun verdict. Le problème est le signal lui-même.
5. **Deux stratégies sur trois ne tradent pratiquement pas** sous les défauts IDENTITY — le dépôt le documente lui-même via l'étude de calibration qui doit forcer POWER_THIRD pour restaurer une exposition, et même là, pas de PnL positif.

**Recommandation honnête** : ne pas déployer ces stratégies avec du capital réel en l'état. Avant toute nouvelle campagne : (a) corriger la lenteur de préparation d'indicateurs pour permettre des fenêtres pluri-annuelles multi-régimes ; (b) re-définir le seuil de funding-trend sur la distribution réelle (0,05 % d'activation = stratégie morte) ; (c) n'évaluer les stratégies qu'en PnL absolu et win rate liquidatif, jamais en excess vs benchmark baissier.

---

### Annexes — artefacts et reproductibilité

- Rapport principal : `/tmp/dao-analysis/primary-365d.json`
- Walk-forward funding : `/tmp/dao-analysis/funding-walkforward.json`
- Sensibilité frais : `/tmp/dao-analysis/fee-sensitivity.json` (script : `analysis-fee-sensitivity.mjs` à la racine, non commité)
- Study calibration : `packages/backtest/.artifacts/studies/confidence-calibration-ETC-ATOM-2022-2026.json`
- Journaux d'exécution : `/tmp/dao-analysis/study-*.log`
- Aucun push effectué. Brief non committé (conforme consigne).
