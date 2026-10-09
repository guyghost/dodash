# Modèle — Politiques d'allocation BTC/ETH sous contrainte de drawdown (protocole figé)

Statut : MODÉLISÉ — protocole **figé avant le premier run** (2026-10-09).
Commité seul, strictement avant le commit « exécution + rapport ». Aucune
politique, aucun paramètre, aucun seuil ne peut être ajouté, retiré ou modifié
après lecture des résultats.

Périmètre **lecture seule côté trading** : aucune stratégie, machine,
config, permission ni déploiement n'est modifié. Seuls ajouts : un script
d'analyse (`docs/analysis/allocation-policies-2026-10-09.py`), ses preuves
(`docs/analysis/evidence-allocation-policies-2026-10-09/`) et un rapport
(`docs/analysis/allocation-policies-2026-10-09.md`).

## 1. Question

L'objectif de l'opérateur est que le capital crypto rapporte, avec un
**drawdown maximal toléré de −50 %**. Les campagnes intraday (2026-10-08) et
daily (2026-10-09) n'ont trouvé aucun edge de signal : ce qui a rapporté est
l'exposition longue elle-même, au prix de drawdowns de 63 à 94 %. Quelle
politique d'allocation simple, long-only et sans levier, tient −50 % tout en
conservant le plus de rendement ?

## 2. Données

Bougies daily Coinbase Advanced déjà archivées et hachées par la campagne
daily long (`docs/analysis/evidence-backtest-daily-long-2026-10-09/job--*.json`,
SHA-256 BTC `f760a0bc…`, ETH `5704eae4…`) : BTC-USD `[2015-07-21,
2026-10-01)`, ETH-USD `[2016-05-19, 2026-10-01)`. Aucune nouvelle collecte.

**Avant le 2016-05-19**, ETH n'existe pas : la poche ETH
est détenue en BTC. À partir du 2016-05-19, chaque politique applique sa
répartition cible BTC/ETH.

## 3. Mécanique commune

- Capital initial 10 000 $, cash rémunéré 0 %, long-only, sans levier.
- Décision à la clôture UTC du jour `t` avec les seules données jusqu'à `t`
  inclus ; ordres exécutés au prix de clôture de `t` ; rendement appliqué à
  partir de `t+1`.
- Frais **60 bps + 2 bps de slippage = 62 bps** sur chaque notionnel acheté
  ou vendu.
- Répartition crypto : **50/50 BTC/ETH** (poche ETH en BTC avant le
  2016-05-19), pour toutes les politiques.
- Rééquilibrage « mensuel + dérive » : au premier jour de chaque mois, **ou**
  dès qu'un poids réel s'écarte de plus de **5 points** de sa cible.
- Volatilité réalisée : écart-type des rendements journaliers sur **30 jours**,
  annualisé √365.
- Tendance : clôture > **moyenne mobile simple 200 jours** de l'actif.

## 4. Politiques figées (8)

| # | Politique | Règle |
| --- | --- | --- |
| P0 | Buy-and-hold 50/50 (référence) | 100 % BTC au départ ; le 2016-05-19, un seul rééquilibrage vers 50/50 ; aucun autre ordre |
| P1 | Rebalancé 100 % | cible 50 % BTC + 50 % ETH, rééquilibrage mensuel + dérive |
| P2 | Part fixe 70 % | cible 35 % BTC + 35 % ETH + 30 % cash, rééquilibrage mensuel + dérive |
| P3 | Part fixe 50 % | cible 25 % BTC + 25 % ETH + 50 % cash, rééquilibrage mensuel + dérive |
| P4 | Ciblage de volatilité | poids de chaque actif = 50 % × min(1, 50 % / vol réalisée 30 j) ; rééquilibrage hebdomadaire (lundi) + dérive |
| P5 | Filtre de tendance | poids de chaque actif = 50 % si tendance, 0 sinon ; évalué chaque jour, ordre au changement d'état ; rééquilibrage mensuel + dérive des actifs investis |
| P6 | Coupe-circuit de drawdown | P1, mais si l'équité tombe à **−35 %** de son plus haut, tout passe en cash ; ré-entrée en P1 lorsque l'**ombre** P1 (portefeuille P1 fictif sans coupe-circuit) remonte de **+20 %** depuis son plus bas atteint depuis la sortie |
| P7 | Tendance × volatilité | poids de chaque actif = 50 % × tendance × min(1, 50 % / vol 30 j) ; rééquilibrage hebdomadaire + dérive, ordre immédiat au changement d'état de tendance |

Échauffement : P4, P5 et P7 restent en cash tant que l'indicateur requis
(30 ou 200 jours) n'est pas disponible pour l'actif ; P0 à P3 et P6 sont
investis dès le premier jour. C'est un désavantage assumé et consigné.

## 5. Fenêtres walk-forward (figées)

Aucune politique n'a de paramètre ajusté : la lecture walk-forward consiste à
mesurer chaque politique, telle quelle, sur des fenêtres consécutives non
chevauchantes, avec un drawdown recalculé depuis le début de chaque fenêtre.

| Fenêtre | Début | Fin (exclusive) |
| --- | --- | --- |
| W1 | 2015-07-21 | 2018-01-01 |
| W2 | 2018-01-01 | 2020-01-01 |
| W3 | 2020-01-01 | 2022-01-01 |
| W4 | 2022-01-01 | 2024-01-01 |
| W5 | 2024-01-01 | 2026-10-01 |

## 6. Métriques

Équité finale, CAGR, volatilité annualisée, Sharpe √365 (cash à 0 %),
**drawdown maximal**, **Calmar** = CAGR / drawdown maximal, exposition
moyenne, nombre d'ordres, frais payés, rendement par année civile, CAGR et
drawdown maximal par fenêtre.

## 7. Critère figé et verdict

1. **Éligibilité** : drawdown maximal ≤ **50 %** sur tout l'historique **et**
   dans chacune des 5 fenêtres.
2. **Classement** des politiques éligibles par **CAGR** décroissant (Calmar
   rapporté à côté).
3. **Alerte de sacrifice** : une politique éligible dont le CAGR est
   inférieur à **50 % du CAGR de P0** est signalée « tient la contrainte en
   sacrifiant l'essentiel du rendement ».

Verdict : la politique éligible de meilleur CAGR, avec ses chiffres face à
P0, ou « aucune politique ne tient −50 % ».

## 8. Multiplicité et portée

8 politiques, aucun paramètre ajusté sur les données. Le classement n'est
pas un test statistique : un écart de CAGR modeste entre deux politiques
peut relever du hasard d'une seule trajectoire historique. Le rapport le dit,
montre la stabilité par année et par fenêtre, et ne recommande aucune
activation : toute mise en paper relève d'une proposition séparée, avec un
modèle d'implémentation dédié.

## 9. Invariants

1. Protocole commité avant le premier run (git le prouve).
2. Données réelles hachées, aucune valeur substituée.
3. Aucune stratégie, config runtime, permission ou déploiement modifié.
4. Long-only, sans levier, aucune activation.
