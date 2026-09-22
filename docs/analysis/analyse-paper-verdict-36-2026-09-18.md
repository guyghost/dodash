# Analyse — Verdict final de la collecte paper #36 (14 jours exacts, 2026-09-18)

**Fenêtre** : collecte #36 bornée `[2026-09-04T17:01:15Z, 2026-09-18T17:01:15Z)`
— 14 jours pleins, dernier cycle `2026-09-18T17:00:39Z` (36 s avant l'échéance).
**Source** : Analytics Engine `dodash_paper_trading` (SQL API, lecture seule) —
39 710 `cycle.completed`. **Scripts** : `paper-session-summary-2026-09-18.mjs`
(variante bornée à l'échéance) et `paper-cost-decomposition-2026-09-18.mjs`
(`END_MS = 2026-09-18T17:01:15Z`). Précédents : points d'étape J+5 / J+7 /
J+9,2 / J+13,5 (`analyse-paper-session-2026-09-*.md`).
**Portée** : signaux de télémétrie uniquement (models/trading-telemetry.md) —
aucune décision n'est dérivée ici ; l'arbitrage #36 tranche sur ces faits.

## 1. Verdict — axes gelés (14 jours)

| Axe | Résultat | Détail |
| --- | --- | --- |
| Continuité 24/7 | **OK — sans faille** | 39 710 cycles (~2 836/j) ; plus grand écart inter-cycles **2,0 min** (10-09 01:28Z) sur 14 jours |
| Alarmes gelées | **0 / 14 jours** | 0 `TERMINAL_FAILED` / `ORDER_OUTCOME_UNKNOWN` ; 0 `ORDER_CONFIRMED` sans exécution ; dailyPnl min **-287,73** (15-09, seuil -1 000) ; exposition «other» max 0 (seuil 20 000) |
| Performance | **Négatif, contenu** | 20 000 → **19 362,67 USD (-637,33, -3,19 %)** ; BTC **-647,51 (-6,48 %)** ; ETH **+10,18 (+0,10 %)** ; drawdown max **-816,22 (-4,08 %)** au creux du 16-09 18:00Z, jamais un seuil approché |
| Rate limiting | Plateau ~12-14 % | 292-401 occurrences/jour, tous auto-récupérés ; `FAILED` terminal 6,1 % |
| Latence | Dérive confirmée, contenue | moyenne 676,93 ms (472,84 avant 08-09 → 740,52 depuis) ; ~90 % ≤ 1 s ; 2 cycles > 20 s récupérés |

**L'objectif opérationnel de #36 est atteint** : la plateforme (DO + alarmes +
paper broker + AE) a tenu 14 jours 24/7 sans aucune alarme gelée ni perte de
continuité. La question d'arbitrage restante est le créneau BTC (§4-§5).

## 2. Distribution des outcomes (39 710 cycles)

| Outcome | n | % | Lecture |
| --- | --- | --- | --- |
| `NO_ACTION` | 28 282 | 71,2 % | nominal |
| `ORDER_CONFIRMED` | 7 579 | 19,1 % | ~541 fills/jour, `executionObserved: true` 100 % |
| `FAILED` | 2 425 | 6,1 % | tous `RATE_LIMITED` (retryable), 0 cycle perdu |
| `RISK_REJECTED` | 928 | 2,3 % | refus déterministes normaux |
| `ORDER_REJECTED` | 496 | 1,2 % | broker paper — **100 % BTC-USD**, code fin non projeté (§5) |

## 3. PnL final par créneau et par jour (clôtures UTC)

| Jour | BTC-USD | ETH-USD | Total | Δ jour |
| --- | --- | --- | --- | --- |
| 09-04 (17:01Z→) | 9 999,60 | 9 999,76 | 19 999,36 | — |
| 09-05 | 9 953,03 | 9 999,53 | 19 952,56 | -46,81 |
| 09-06 | 9 919,13 | 10 001,28 | 19 920,41 | -32,14 |
| 09-07 | 9 784,14 | 10 001,09 | 19 785,24 | -135,17 |
| 09-08 | 9 696,05 | 10 003,59 | 19 699,64 | -85,60 |
| 09-09 | 9 644,57 | 10 001,26 | 19 645,83 | -53,81 |
| 09-10 | 9 553,29 | 9 995,50 | 19 548,79 | -97,04 |
| 09-11 | 9 548,34 | 10 018,45 | 19 566,78 | +17,99 |
| 09-12 | 9 451,97 | 10 013,21 | 19 465,18 | -101,60 |
| 09-13 | 9 362,21 | 10 006,46 | 19 368,67 | -96,51 |
| 09-14 | 9 501,32 | 10 024,89 | 19 526,21 | +157,54 |
| 09-15 | 9 195,30 | 10 006,82 | 19 202,12 | **-324,09** |
| 09-16 | 9 220,28 | 9 991,56 | 19 211,84 | +9,72 |
| 09-17 | 9 298,39 | 9 982,56 | 19 280,95 | +69,11 |
| **09-18 (17:00Z)** | **9 352,49** | **10 010,18** | **19 362,67** | **+81,72** |

- 9 journées négatives, 5 positives ; les **4 dernières clôtures sont
  positives** (+9,72 / +69,11 / +81,72 et +157,54 le 14-09) — la fenêtre
  se referme sur un régime volatil favorable.
- Positions finales : BTC 0,0283 (~2 292 USD, 22,9 % du créneau — engagement
  maximal de la fenêtre) ; ETH 0,4722 (~1 231 USD).

## 4. Décomposition coûts vs signal (14 jours)

| | BTC-USD | ETH-USD |
| --- | --- | --- |
| Δ équité nette | **-647,51 USD (-6,48 %)** | **+10,18 USD (+0,10 %)** |
| Notional échangé cumulé | 1 192 440 USD | 46 401 USD |
| Rotations du capital | **119,2×** (~8,5/j) | 4,6× |
| Fills | 3 454 (~247/j) | 4 123 |
| Coûts simulés (8 bps) | **-953,95 USD** (~68,1/j) | -37,12 USD |
| **Marché/signal (brut)** | **-1 601,46 USD** | -26,94 USD |
| PnL moyen / fill (brut) | **-0,11 USD** | ~0,00 USD |

1. **Fait établi n°1 — l'espérance brute par trade BTC est négative sur la
   fenêtre complète** : -0,11 USD par fill avant coûts (3 454 fills, 14 j).
   À coûts nuls, le créneau BTC serait ≈ -8,0 % : le problème premier est le
   signalement 1 min BTC, le churn double la facture (coûts = 147 % du
   glissement net).
2. **Fait établi n°2 — dépendance au régime** : jours bruts BTC 14→18-09 :
   +101,08 / -203,07 / +27,19 / +59,92 / +28,74 (4 positifs sur 5), contre 6
   journées consécutivement négatives du 05 au 10-09. La pire journée (15-09,
   -203,07 brut) coïncide avec le stress intraday (-287,73). Hypothèse à
   instruire côté backtest (models/regime-aware-selector.md, campagne #40)
   avant toute décision de mix.
3. **Fait établi n°3 — ETH finit net positif mais invérifiable** : +10,18
   nets à un engagement ~27× inférieur à BTC (cause racine confirmée dans le
   code : sizing `NATIVE` par défaut, quantité partagée — voir
   `analyse-paper-session-2026-09-18.md` §5). Sa « neutralité » n'est pas un
   edge démontré, c'est une sous-utilisation ; à sizing corrigé (proposition
   #48), la fenêtre suivante testera réellement le mix ETH.

## 5. Anomalies ouvertes (hors télémétrie décisionnelle)

- **ORDER_REJECTED (496, 100 % BTC)** : 0 le 16-09 vs 82 le 15-09 — non
  corrélé au stress PnL ; code fin toujours hors projection AE (lecture DO
  nécessaire) → proposition #47 (ouverte).
- **Latence** : +57 % de dérive moyenne (473 → 741 ms) sans emballement ;
  à documenter comme dette d'exploitation.
- **Instance post-échéance** : le worker paper continue de tourner (3 527
  cycles émis après le 18-09 17:01:15Z, dernier au 19-09 10:54Z). La collecte
  #36 est close ; teardown (runbook §6) ou fenêtre suivante (#36bis,
  propositions #47/#48) sont des décisions d'arbitrage.

## 6. Entrées factuelles pour l'arbitrage #36

1. **Créneau BTC** : espérance brute négative (§4.1) + dépendance au régime
   possible (§4.2) → revue du mix / du timeframe à instruire par proposition
   dédiée (Model → Review → Implement → Verify), adossée au protocole OOS de
   la campagne #40 — pas par la télémétrie.
2. **Créneau ETH** : corriger le sizing (proposition #48, ouverte) avant
   toute conclusion de performance sur ce créneau.
3. **Télémétrie** : projeter le code fin des refus broker (proposition #47,
   ouverte).
4. **Plateforme** : verdict opérationnel **positif sans réserve** (§1) —
   l'hypothèse de déploiement 24/7 paper sur Cloudflare est validée.
