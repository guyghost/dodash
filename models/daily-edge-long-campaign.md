# Modèle — Edge daily au-delà de l'exposition longue, historique long (protocole figé)

Statut : MODÉLISÉ — protocole **figé avant le premier run** (2026-10-09).
Ce fichier est commité seul, strictement avant le commit « exécution +
rapport » ; l'historique git le prouve. Aucune cellule, aucun seuil, aucun
benchmark ne peut être ajouté, retiré ou modifié après lecture des résultats.

Périmètre **lecture seule côté trading** : aucune stratégie, machine,
config, permission ni déploiement n'est modifié. Seuls ajouts : un script de
rejeu (`packages/backtest/scripts/daily-edge-long-2026-10.ts`), un script
d'analyse (`docs/analysis/backtest-daily-long-2026-10-09.py`) et un rapport
(`docs/analysis/backtest-daily-long-2026-10-09.md`, preuves dans
`docs/analysis/evidence-backtest-daily-long-2026-10-09/`).

## 1. Question

Les stratégies daily existantes ont-elles un **edge au-delà de l'exposition
longue** ? Le backtest intraday du 2026-10-08 a montré que les résultats
changent de signe avec le marché. Il faut séparer ce que rapporte le simple
fait d'être exposé (bêta) de ce que rapporte le choix du moment (alpha).

## 2. Grille figée

### 2.1 Actifs et fenêtres

Historique daily complet de Coinbase Advanced (bougies publiques), vérifié le
2026-10-09 avant le gel : premier jour BTC-USD 2015-07-20, ETH-USD
2016-05-18. Le premier jour, potentiellement partiel, est exclu.

| Actif | Début (inclus) | Fin (exclusive) |
| --- | --- | --- |
| BTC-USD | 2015-07-21 | 2026-10-01 |
| ETH-USD | 2016-05-19 | 2026-10-01 |

Un seul rejeu causal par (actif, configuration, frais) sur toute la fenêtre ;
les découpes (§2.4) sont des lectures de ce rejeu, sans re-paramétrage.

### 2.2 Configurations (registre existant, aucun réglage nouveau)

Les trois configurations **actives** de la campagne intraday :
`rsi-reversion` (30/70), `ema-cross` calibrée `POWER_THIRD`, `breakout`
(lookback 20) calibrée `POWER_THIRD`. Construction identique à
`runBacktestSuite`. Configuration commune identique à
`models/intraday-edge-campaign.md` §2.6 (capital 10 000 $, notional cible
1 000 $, SL 150 bps / TP 300 bps, exécution à l'ouverture suivante,
long-only, `DEFAULT_INDICATOR_CONFIG`).

### 2.3 Bras de frais (par côté, + slippage 2 bps par côté)

M40 (40 bps), **T60 (60 bps, bras de décision)**, T120 (120 bps). Mêmes
sources que la campagne intraday.

### 2.4 Découpes figées

- **Années civiles** : 2016 à 2025 complètes pour les deux actifs (BTC 2015
  et ETH 2016 partielles, 2026 partielle jusqu'au 2026-09-30) ; seules les
  années complètes comptent pour la stabilité (§4).
- **Régime d'une année**, calculé sur le rendement buy-and-hold de l'actif
  pendant l'année (jamais déclaré à la main) : **haussier** > +20 %,
  **baissier** < −20 %, **latéral** sinon.

Les données manquantes suivent la règle de comblement de la campagne
intraday (bougie plate comptée ; non exécutable au-delà de 0,5 %).

## 3. Mesures

Séries journalières (clôture UTC) issues du rejeu : équité `E_t`, position
`q_t`, rendement de la stratégie `r_s,t = E_t / E_{t−1} − 1`, rendement de
l'actif `r_m,t = close_t / close_{t−1} − 1`, exposition
`e_t = q_t × close_t / E_t`.

1. **Alpha/bêta** : régression OLS `r_s,t = α + β r_m,t + ε_t` ; erreurs
   standard **HAC Newey-West, 5 retards** ; α annualisé × 365 ; p-valeur
   unilatérale (H1 : α > 0, loi normale).
2. **Exposition aléatoire appariée (Monte Carlo)** : 2 000 tirages par
   cellule. Chaque tirage permute aléatoirement l'ordre des **périodes
   d'exposition** de la stratégie (blocs maximaux de `e_t` > 0 et de
   `e_t` = 0, longueurs et niveaux d'exposition conservés), applique
   `r_rand,t = e_perm,t−1 × r_m,t − c`, où `c` = frais totaux réels de la
   cellule ÷ nombre de jours (mêmes frais totaux). Statistique : Sharpe
   journalière annualisée √365. p-valeur = part des tirages dont la Sharpe
   ≥ celle de la stratégie. Graine fixe `20261009`.
3. Rapportés aussi : PnL, Sharpe √365, drawdown maximal, trades, frais,
   temps en marché, buy-and-hold.

## 4. Critère de succès (figé)

Une configuration a un **edge au-delà de l'exposition** si et seulement si,
au bras **T60** et **sur les deux actifs** :

1. α > 0 avec p HAC unilatérale < **0,05 / 6** (Bonferroni : 3
   configurations × 2 actifs) ;
2. p Monte Carlo < **0,05 / 6** (la stratégie bat ≥ 99,17 % des expositions
   aléatoires appariées) ;
3. α annuel > 0 dans une **majorité stricte** des années civiles complètes
   (2016–2025, 10 ans : ≥ 6) ;
4. au moins **30 trades** sur la fenêtre.

Verdict global :

- **EDGE** — au moins une configuration remplit 1–4. Elle reste une
  candidate : aucune activation ; la suite relève d'une proposition séparée.
- **PAS D'EDGE** — aucune configuration ne remplit 1–4.

La lecture par régime (α moyen en années haussières, baissières, latérales)
est descriptive et ne modifie pas le verdict.

## 5. Invariants

1. Protocole commité avant le premier run (git le prouve).
2. Aucune valeur substituée ; échec ou non-exécutabilité consigné avec raison.
3. Aucune stratégie, config runtime, permission ou déploiement modifié.
4. Aucune conclusion d'edge hors du critère §4 ; aucune activation.

## Erratum du 2026-10-10 (revue PR #24)

Le §2.4 se contredisait : « 2016 à 2025 complètes pour les deux actifs » et
« ETH 2016 partielle » (cotation le 2016-05-19), et le §4 fixait « 10 ans :
≥ 6 » pour les deux actifs. La règle retenue est celle de l'intention écrite
du §2.4 — **seules les années complètes comptent** : BTC 2016–2025 (10 ans,
majorité stricte ≥ 6), ETH 2017–2025 (9 ans, majorité stricte ≥ 5). Correction
appliquée après la première exécution, de nature factuelle (calendrier de
cotation), sans effet sur le verdict : le critère c1 échoue pour toutes les
cellules. Les seuils c1, c2 et c4 sont inchangés.
