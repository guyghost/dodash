# Analyse — Chantier 1 : décomposition coûts vs marché du glissement paper (2026-09-13)

**Périmètre** : collecte #36, `2026-09-04T17:01:15Z` → `2026-09-13T21:18Z`
(~9,2 jours, 26 077 cycles). Réponse à la question ouverte n°3 du point
d'étape `analyse-paper-session-2026-09-13.md` : quelle part du glissement BTC
est imputable aux coûts de churn vs au signalement ?
**Méthode** : quantités échangées par fill (diffs de position, télémétrie AE)
× prix publics Coinbase (bougies horaires, interpolation) → notional échangé →
coûts simulés au modèle du broker paper (`feeBps 6 + slippageBps 2`,
`apps/agent/src/configuration.ts`, défauts non surchargés au `/start`).
**Précision** : estimation — prix de fill approché par la bougie horaire
(± qq % sur le notional) ; coûts = modèle paper par définition (pas des frais
réels) ; un cycle ETH du 10-09 07:48Z à équité non fiable (flag null, valeur
sentinelle 0) est exclu des diffs. Script : `paper-cost-decomposition-2026-09-13.mjs`.
**Portée** : signaux de télémétrie — aucune décision n'en est dérivée ici.

## 1. Résultat principal

| | BTC-USD | ETH-USD |
| --- | --- | --- |
| Δ équité totale (net) | **-627,06 USD** | **+7,04 USD** |
| Notional échangé cumulé | 827 349 USD | 30 867 USD |
| Rotations du capital | **82,7×** (9,2 j) | 3,1× |
| Fills (`ORDER_CONFIRMED`) | 2 359 | 2 755 |
| Coûts simulés (8 bps) | **-661,88 USD** | **-24,69 USD** |
| **Marché/signal (brut)** | **-1 288,94 USD** | **-17,66 USD** |
| PnL moyen / fill | -0,16 USD | 0,00 USD |
| Coût moyen / fill | 0,28 USD | 0,01 USD |
| Position moyenne (USD) | ~4 600 (46 % du créneau) | ~355 (3,5 % du créneau) |

## 2. Lecture

1. **Les frais ne sont pas la cause première du glissement BTC — mais ils
   doublent la facture.** Le mix de stratégies BTC perd **-1 289 USD bruts**
   (marché/signal) sur la fenêtre ; les coûts de churn y ajoutent -662 USD
   (106 % du résultat net). À coûts nuls, BTC serait quand même à -6,4 % :
   le problème est le signalement, pas seulement le churn.
2. **Churn BTC très élevé** : 82,7 rotations de capital (~9/jour), ~256
   fills/jour, chaque fill perdant en moyenne 0,16 USD brut et coûtant 0,28
   USD. Espérance par trade négative AVANT coûts = le critère à retenir pour
   l'arbitrage du 18-09.
3. **ETH : signal à peine négatif (-17,66 brut) et quasi inchangé net (+7,04)
   — mais le créneau n'exploite presque rien** : 3,1 rotations, position
   moyenne ~3,5 % du capital, fills de ~11 USD. Sa neutralité vient surtout de
   sa sous-utilisation, pas d'un edge démontré.
4. **Anomalie de dimensionnement à faire reviewer** : fills ETH ≈ 11 USD
   contre 350 USD pour BTC, soit un rapport ≈ 27× ≈ rapport des prix
   (~30×) — cohérent avec une taille exprimée en **quantité** commune plutôt
   qu'en **notional** par produit. Simple hypothèse à partir de la télémétrie ;
   à confirmer sur le code/DO et, le cas échéant, à instruire par une
   proposition dédiée (Model → Review → Implement → Verify).
5. **Répartition temporelle du glissement BTC** (brut) : négative presque
   partout, pires journées 07 (-135) et 12 (-96) ; aucune journée ne
   compense. Le rebond du 11-09 (+9 brut) est isolé.

## 3. Données de qualité télémétrie

- 1 cycle sur 26 077 avec équité non fiable (flag null → 0) : ETH, 2026-09-10
  07:48Z. L'encodage du modèle (valeur sentinelle + flag) a bien filtré le
  fait ; les diffs naïves doivent exclure ces lignes (fait ici).
- Les codes fins de refus broker (`ORDER_REJECTED`) restent hors projection AE
  (limite déjà documentée au point d'étape).

## 4. Questions proposées pour l'arbitrage du 18-09 (hors télémétrie)

1. Créneau BTC : revue du mix de stratégies (espérance brute par trade
   négative sur 9,2 j) — poursuivre en l'état pour finir la collecte, puis
   décision ; toute modification passera par une proposition dédiée.
2. Créneau ETH : la sous-utilisation (3,5 %) est-elle voulue (risk targeting)
   ou le fruit de l'anomalie de dimensionnement §2.4 ?
3. Coûts : si le mix BTC est conservé, un plafond de rotations (rate de
   re-signalement) réduirait ~66 USD/jour de coûts simulés — à modéliser
   avant toute implémentation.
