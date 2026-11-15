# Edge daily au-delà de l'exposition longue, historique long — 9 octobre 2026

**Verdict : PAS D'EDGE.** Aucune des trois stratégies daily actives ne remplit
le critère figé. Sur 2015/2016 → 2026-09 :

- **Toujours en marché.** Elles sont exposées **98 à 99 % du temps**, avec un
  bêta de 0,46 à 0,94.
- **Alpha négatif presque partout.** L'α annualisé est négatif dans 5
  cellules sur 6, de −13 % à −2 % par an. La seule cellule positive (rsi ETH,
  +6,1 %/an) n'est pas significative (p = 0,16).
- **Lecture.** Les gains observés sont ceux d'un long-only partiel sur deux
  actifs qui ont été multipliés par environ 200 à 300. Ce ne sont pas des
  gains de timing. Les frais ne jouent aucun rôle (25 à 93 trades en 10 ans).

Lecture seule : aucune activation, aucune modification de stratégie ni de
config.

## Protocole et données

- **Protocole.** [models/daily-edge-long-campaign.md](../../models/daily-edge-long-campaign.md),
  commité seul (`ab4458f`) **avant** le premier run.
- **Grille.**
  - Fenêtres : BTC-USD `[2015-07-21, 2026-10-01)` (4 090 bougies) et ETH-USD
    `[2016-05-19, 2026-10-01)` (3 787 bougies). C'est tout l'historique daily
    Coinbase Advanced, vérifié avant le gel.
  - Configurations : `rsi-reversion`, `ema-cross` POWER_THIRD et `breakout`
    POWER_THIRD, défauts du dépôt.
  - Bras de frais : 40, **60 (décision)** et 120 bps par côté, plus 2 bps de
    slippage.
- **Données.** Bougies comblées : 0 pour BTC, 2 pour ETH (0,05 %). SHA-256 :
  BTC `f760a0bc…`, ETH `5704eae4…` (complets dans `summary.json`).
  La reconstruction de l'équité à partir des fills est exacte (erreur
  relative 0).
- **Mesures.**
  - Régression `r_strat = α + β r_actif` avec erreurs HAC Newey-West à 5
    retards, et correction de Bonferroni (seuil 0,05 / 6).
  - Monte Carlo d'exposition aléatoire appariée : 2 000 tirages, graine
    20261009.
  - α annuel par année civile complète de chaque actif (BTC 2016–2025, ETH
    2017–2025, cf. erratum), avec le régime de chaque
    année calculé sur le buy-and-hold (> +20 % haussier, < −20 % baissier,
    latéral sinon).

## Résultats (bras T60)

| Actif | Configuration | Trades | Rendement total | Sharpe | Drawdown max | Temps en marché | β | α annualisé | p (HAC) | Années α > 0 | p Monte Carlo |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BTC | rsi-reversion | 93 | ×13,8 | 0,71 | 77 % | 99 % | 0,70 | **−12,5 %** | 0,93 | 5/10 | 0,000 \* |
| BTC | ema-cross P3 | 44 | ×6,7 | 0,66 | 63 % | 98 % | 0,46 | **−10,4 %** | 0,98 | 2/10 | 0,51 |
| BTC | breakout P3 | 34 | ×163,5 | 1,04 | 83 % | 98 % | 0,94 | **−3,3 %** | 0,87 | 2/10 | 0,53 |
| ETH | rsi-reversion | 33 | ×260,9 | 1,04 | 94 % | 99 % | 0,94 | **+6,1 %** | 0,16 | 5/9 | 0,000 \* |
| ETH | ema-cross P3 | 28 | ×8,1 | 0,64 | 75 % | 98 % | 0,53 | **−13,1 %** | 0,94 | 0/9 | 0,49 |
| ETH | breakout P3 | 25 | ×85,3 | 0,93 | 93 % | 99 % | 0,86 | **−2,2 %** | 0,62 | 0/9 | 1,00 |

Buy-and-hold sur la même fenêtre : BTC **×298,5** (Sharpe 1,10) et ETH
**×203,6** (Sharpe 1,00). Le rsi ETH bat le buy-and-hold en total (×260,9),
mais avec un drawdown de 94 %, un α non significatif et un bêta de 0,94.

\* **Monte Carlo dégénéré pour rsi-reversion.** La stratégie est en marché
99 % du temps. Ses blocs d'exposition se réduisent quasiment à un seul, et
toutes les permutations donnent la même série. Le p = 0 vient de différences
infimes de répartition des frais : la Sharpe de la stratégie (0,71) et le
99e centile aléatoire (0,70) sont égaux à 0,01 près. Le critère c2 est donc
« rempli » par artefact, sans valeur de preuve. Il ne change pas le verdict :
le critère c1 (α HAC) échoue pour toutes les cellules. Plus généralement, le
Monte Carlo n'a pas de pouvoir discriminant ici, faute de période hors marché.
L'α HAC est le test qui porte la conclusion.

| Critère figé (T60, deux actifs) | rsi | ema P3 | breakout P3 |
| --- | --- | --- | --- |
| c1 α > 0, p HAC < 0,0083 | ✗ ✗ | ✗ ✗ | ✗ ✗ |
| c2 p Monte Carlo < 0,0083 | ✓\* ✓\* | ✗ ✗ | ✗ ✗ |
| c3 α > 0 en majorité stricte des années complètes (BTC ≥ 6/10, ETH ≥ 5/9) | ✗ ✓ | ✗ ✗ | ✗ ✗ |
| c4 ≥ 30 trades | ✓ ✓ | ✓ ✗ | ✓ ✗ |
| **Edge** | **non** | **non** | **non** |

## Par régime (α annualisé moyen sur les années complètes, T60, descriptif)

| Actif | Configuration | Haussier | Baissier | Latéral |
| --- | --- | ---: | ---: | ---: |
| BTC (7 / 2 / 1 ans) | rsi | +0,9 % | +1,4 % | 0,0 % |
| BTC | ema P3 | −3,6 % | −5,3 % | −0,9 % |
| BTC | breakout P3 | +0,3 % | −0,4 % | 0,0 % |
| ETH (5 / 2 / 2 ans) | rsi | 0,0 % | 0,0 % | 0,0 % |
| ETH | ema P3 | −11,8 % | −6,6 % | −4,9 % |
| ETH | breakout P3 | −11,1 % | −1,5 % | −1,3 % |

Aucune stratégie ne protège de façon notable en régime baissier : le meilleur
α moyen y est +1,4 %/an (rsi BTC), négligeable face aux baisses. Les années 2018 et 2022
(−64 % à −82 %) sont subies avec un bêta de 0,5 à 0,9. Aucune ne crée de
valeur en latéral non plus. Les α annuels sont estimés sur environ 365 points
chacun ; ils sont bruités et ne servent qu'à la lecture.

## Ce que cela veut dire pour « qu'il rapporte »

- **Ce que montrent les chiffres.** Les stratégies existantes ne choisissent
  pas mieux que le hasard leurs moments d'exposition. Elles se comportent
  comme un buy-and-hold partiel : rendement plus faible (sauf rsi ETH), et
  drawdowns de 63 à 94 %.
- **Ce qui a réellement rapporté.** Sur la période, c'est l'exposition
  longue elle-même. Si l'objectif est le profit, la question pertinente
  devient un choix d'allocation (part du capital exposée, rééquilibrage,
  limite de drawdown), pas la recherche de signal avec ces stratégies.
- **Avec l'intraday.** Combiné au backtest intraday du 2026-10-08 (aucun edge
  après frais), aucun signal du registre ne justifie aujourd'hui une
  activation ni un passage en live.

## Limites

1. **Monte Carlo non informatif** pour des stratégies exposées 98–99 % du
   temps (voir \*). Le verdict repose sur c1 et c3.
2. **Survivant.** BTC et ETH sont les deux actifs qui ont le plus monté. Un
   bêta élevé y paraît rentable a posteriori, ce qui ne prédit rien.
3. **Un seul jeu de paramètres** (défauts du dépôt), long-only. La question
   « une autre stratégie aurait-elle un edge » reste ouverte et relèverait
   d'un nouveau protocole.
4. **Erreurs standard asymptotiques.** HAC à 5 retards et loi normale. La
   queue épaisse des rendements crypto rend les p-valeurs approximatives,
   mais aucun α n'est proche du seuil (le meilleur p vaut 0,16 contre 0,0083
   requis).
5. **Frais et slippage fixes.** Peu importe ici : 25 à 93 trades en 10 ans.
6. **Pas de taux sans risque** dans la régression. Le cash non investi ne
   rapporte rien dans le rejeu.

## Preuves et reproduction

- [evidence-backtest-daily-long-2026-10-09/](evidence-backtest-daily-long-2026-10-09/)
  - `job--BTC-USD.json`, `job--ETH-USD.json` : bougies, équité et fills des 9
    rejeux par actif.
  - `summary.json` : régressions, Monte Carlo, α annuels, critères.
- Rejeu (réseau, environ 6 min par actif) :
  `pnpm dlx tsx packages/backtest/scripts/daily-edge-long-2026-10.ts <PRODUIT>`.
- Analyse (hors réseau, environ 7 s) :
  `python3 docs/analysis/backtest-daily-long-2026-10-09.py`.

## Erratum (revue PR #24, 2026-10-10)

Le script comptait 2016 comme année complète pour ETH (coté le 2016-05-19),
contrairement au §2.4 du protocole (« seules les années complètes
comptent ») : les années complètes d'ETH sont 2017–2025 (9), majorité stricte
≥ 5. Corrigé dans `backtest-daily-long-2026-10-09.py` et `summary.json`
régénéré : rsi-reversion ETH remplit désormais c3 (5/9) ; la table par régime
est recalculée (ETH 5/2/2 ans ; α baissier ETH rsi 0,0 %, ema −6,6 %,
breakout −1,5 %). **Verdict inchangé** : c1 (α HAC significatif) échoue pour
toutes les cellules. Erratum daté aussi consigné dans le protocole
(`models/daily-edge-long-campaign.md`).
