# Politiques d'allocation BTC/ETH sous drawdown −50 % — 9 octobre 2026

**Verdict : une seule politique tient −50 %. C'est P7, tendance × ciblage de
volatilité.** Sur 2015-07-21 → 2026-09-30, frais 62 bps inclus, elle garde la
plus grande partie du rendement du marché :

| | P7 tendance × volatilité | P0 buy-and-hold 50/50 |
| --- | ---: | ---: |
| Multiple du capital | ×108,9 | ×289,4 |
| CAGR | +52,0 % | +65,9 % |
| **Drawdown maximal** | **45,6 %** | 89,8 % |
| Pire drawdown sur une fenêtre | 35 % | 90 % |
| Sharpe | 1,39 | 1,06 |
| Calmar | **1,14** | 0,73 |
| Exposition moyenne | 41 % | 100 % |

- **Sur tout l'historique,** P7 rapporte moins que le buy-and-hold, à cause de
  2017 où elle était peu exposée. **Depuis 2018,** elle fait mieux (CAGR
  +26,3 % contre +18,9 %) avec un drawdown divisé par plus de deux.
- **Ce n'est pas un sacrifice au sens du protocole :** son CAGR est supérieur
  à 50 % de celui de P0.
- **Réserves.** C'est la seule des 8 politiques testées qui passe, avec une
  marge d'environ 4 points sous la limite, sur une seule trajectoire
  historique.
- **Elle n'est pas implémentable telle quelle** dans le moteur paper actuel
  (§ Implémentabilité).

Lecture seule : aucune activation, aucune modification de stratégie ni de
config.

## Protocole et données

- **Protocole.** [models/allocation-policies-campaign.md](../../models/allocation-policies-campaign.md),
  commité seul (`d620d5e`) **avant** le premier run.
- **Règles communes.** 8 politiques, sans aucun paramètre ajusté. Long-only,
  sans levier, cash à 0 %, frais 60 + 2 bps sur chaque notionnel traité,
  décision et exécution à la clôture UTC.
- **Contrainte de drawdown.** Elle porte sur tout l'historique **et** sur 5
  fenêtres walk-forward non chevauchantes (W1 2015-07→2017, W2 2018–2019,
  W3 2020–2021, W4 2022–2023, W5 2024→2026-09).
- **Données.** Ce sont les bougies daily Coinbase archivées par la campagne
  daily long (SHA-256 BTC `f760a0bc…`, ETH `5704eae4…`), sans nouvelle
  collecte. Avant le 2016-05-19, la poche ETH est détenue en BTC.
- **Précision fixée avant le run** et inscrite dans le script : pour P6, le
  plus haut de référence est remis à l'équité de ré-entrée. Sans cette
  remise, la règle se redéclencherait immédiatement.

## Résultats (tout l'historique)

| # | Politique | Multiple | CAGR | Volatilité | Sharpe | **Drawdown max** | Calmar | Expo. moy. | Ordres | Éligible |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| P0 | Buy-and-hold 50/50 | ×289,4 | +65,9 % | 74 % | 1,06 | 89,8 % | 0,73 | 100 % | 3 | non |
| P1 | Rebalancé 100 % | ×505,3 | +74,4 % | 73 % | 1,13 | 87,9 % | 0,85 | 100 % | 392 | non |
| P2 | Part fixe 70 % | ×162,9 | +57,6 % | 51 % | 1,15 | 74,4 % | 0,77 | 70 % | 409 | non |
| P3 | Part fixe 50 % | ×56,1 | +43,3 % | 36 % | 1,17 | 59,6 % | 0,73 | 50 % | 390 | non |
| P4 | Ciblage de volatilité | ×115,5 | +52,8 % | 49 % | 1,12 | 72,9 % | 0,72 | 74 % | 1 353 | non |
| P5 | Filtre de tendance SMA200 | ×478,7 | +73,5 % | 53 % | 1,31 | 68,6 % | 1,07 | 55 % | 428 | non |
| P6 | Coupe-circuit −35 % | ×194,8 | +60,1 % | 66 % | 1,05 | 84,7 % | 0,71 | 87 % | 412 | non |
| **P7** | **Tendance × volatilité** | **×108,9** | **+52,0 %** | **34 %** | **1,39** | **45,6 %** | **1,14** | 41 % | 926 | **oui** |

**Drawdown maximal par fenêtre** (CAGR de la fenêtre / drawdown) :

| # | W1 2015–17 | W2 2018–19 | W3 2020–21 | W4 2022–23 | W5 2024–26 |
| --- | --- | --- | --- | --- | --- |
| P0 | +444 % / 55 % | −45 % / **90 %** | +275 % / 57 % | −16 % / 70 % | +15 % / 60 % |
| P3 | +175 % / 26 % | −16 % / **60 %** | +121 % / 31 % | −2 % / 40 % | +13 % / 35 % |
| P5 | +441 % / 46 % | −19 % / **64 %** | +115 % / 51 % | +25 % / 20 % | +19 % / 32 % |
| **P7** | +194 % / 27 % | −4 % / 35 % | +81 % / 32 % | +22 % / 19 % | +22 % / 27 % |

Les autres politiques sont dans `summary.json`. Aucune autre ne tient 50 %
dans W2 (krach 2018). Même la part fixe de 50 % (P3) y tombe de 60 %.

**Rendement par année civile :**

| Année | P0 | P5 | **P7** |
| --- | ---: | ---: | ---: |
| 2015 (partielle) | +54 % | 0 % | 0 % |
| 2016 | +40 % | +72 % | +67 % |
| 2017 | +2 840 % | +3 535 % | +746 % |
| 2018 | −79 % | −48 % | **−25 %** |
| 2019 | +45 % | +27 % | +23 % |
| 2020 | +363 % | +149 % | +147 % |
| 2021 | +204 % | +85 % | +33 % |
| 2022 | −67 % | −6 % | **−5 %** |
| 2023 | +112 % | +67 % | +58 % |
| 2024 | +75 % | +58 % | +63 % |
| 2025 | −9 % | −15 % | −9 % |
| 2026 (→ 30-09) | −7 % | +19 % | +16 % |

P7 perd peu les années de krach (−25 % en 2018, −5 % en 2022). En échange,
elle capture une fraction des années explosives (2017, 2021). Sa CAGR totale
inférieure au buy-and-hold vient presque entièrement de 2017. Depuis 2018,
l'ordre s'inverse (lecture complémentaire, hors critère) :

| Depuis 2018-01-01 | Multiple | CAGR | Pire drawdown de fenêtre |
| --- | ---: | ---: | ---: |
| P0 buy-and-hold | ×4,56 | +18,9 % | 90 % |
| P5 tendance | ×7,65 | +26,2 % | 64 % |
| **P7 tendance × volatilité** | **×7,72** | **+26,3 %** | **35 %** |

## Implémentabilité dans le moteur paper actuel

**Non, pas en l'état.** P7 se décompose naturellement en deux poches
indépendantes de 50 % (BTC, ETH). Cela correspond aux créneaux par produit du
portefeuille paper multi-produit (`models/multi-product-portfolio.md`). Il
manque :

1. **Indicateurs.** Aucune sortie SMA200 : le prédicat `sma` existe en Prolog
   mais n'est pas exposé dans `IndicatorConfig`. La volatilité historique est
   en 20 jours, en log-rendements, et non annualisée. Il faut un champ de
   tendance de long terme et une volatilité 30 jours configurable.
2. **Une stratégie d'exposition cible.** Elle exprimerait un poids voulu en %
   de l'équité de la poche, `trend × min(1, 0,5 / vol)`. Les stratégies
   actuelles émettent un signal BUY/SELL avec un notionnel cible de 1 000 $.
3. **Rééquilibrage vers la cible.** Achat ou vente partielle jusqu'au poids
   voulu, au plus chaque semaine ou au changement de tendance, avec seuil de
   dérive de 5 points. Le cycle actuel décide un ordre par bougie à partir
   d'un signal.
4. **Garde-fous de risque incompatibles.** Le SL/TP de 150/300 bps, le
   `maxOrderNotional` de 2 000 $ et le `maxDailyLoss` de 1 000 $ couperaient
   la politique au premier mouvement normal du marché. Il faut les remplacer
   ou les re-paramétrer pour cette politique, par décision de risque
   modélisée.
5. **Modèle et revue.** Ce sont un nouveau modèle de stratégie et de sizing,
   des invariants (pas de levier, exposition ≤ 100 % de la poche) et un
   protocole paper avant tout live. L'ordre est Model → Review → Implement →
   Verify.

## Limites

1. **Une seule trajectoire historique, 8 politiques.** Le classement n'est
   pas un test statistique. Un seul passage d'éligibilité, avec environ 4
   points de marge, peut ne pas se reproduire. Les paramètres (SMA200,
   vol 30 j, cible 50 %) sont conventionnels et n'ont pas été ajustés, mais
   ils n'ont pas non plus été validés hors échantillon.
2. **Dépendance à 2017 et biais du survivant.** BTC et ETH sont les gagnants
   de la décennie. Le CAGR absolu (+52 %/an) ne se projette pas.
3. **Exécution idéalisée.** Ordres à la clôture même qui sert au signal,
   frais et slippage fixes (62 bps), pas d'impact de marché, cash à 0 %.
   Avec 926 ordres en 11 ans, les frais pèsent (211 k$ cumulés sur une
   équité finale d'environ 1,09 M$).
4. **Échauffement.** P4, P5 et P7 restent en cash les 200 premiers jours
   (2015–début 2016). C'est un désavantage assumé.
5. **Le drawdown réel peut dépasser l'historique.** −45,6 % en backtest ne
   garantit pas −50 % en live, surtout lors d'un krach en un jour (la
   tendance et la volatilité ne réagissent qu'à la clôture).

## Preuves et reproduction

- [evidence-allocation-policies-2026-10-09/summary.json](evidence-allocation-policies-2026-10-09/summary.json) :
  métriques, fenêtres, années, SHA-256 des datasets et du script.
- Calcul (hors réseau, moins d'une seconde) :
  `python3 docs/analysis/allocation-policies-2026-10-09.py`.

## Erratum (revue PR #24, 2026-10-10)

Les métriques de période complète partaient de l'équité de fin du premier
jour, déjà nette des frais du premier ordre, alors que les fenêtres partaient
bien du capital initial. Corrigé (série préfixée par 10 000 $) et
`summary.json` régénéré : écarts ≤ 0,1 point (P0 CAGR 65,9 %, Calmar 0,73 ;
P1 74,4 % ; P2 57,6 % / 0,77 ; P6 60,1 % ; P7 Sharpe 1,39). P7 ne traite pas
le premier jour : CAGR, drawdown et Calmar inchangés. **Verdict inchangé.**
