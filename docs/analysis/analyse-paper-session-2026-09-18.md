# Analyse — Résumé de session paper 24/7 (collecte #36, veille d'arbitrage 2026-09-18)

**Fenêtre analysée** : collecte #36 valide uniquement, `2026-09-04T17:01:15Z` →
`2026-09-18T05:25Z` (~13,5 jours sur les 14 requis ; échéance d'arbitrage
**aujourd'hui** `2026-09-18T17:01:15Z`). **Source** : Analytics Engine
`dodash_paper_trading` (SQL API, lecture seule) — 38 342 `cycle.completed`.
Scripts : `paper-session-summary-2026-09-09.mjs` et
`paper-cost-decomposition-2026-09-18.mjs` (fenêtre étendue + bougies Coinbase
découpées en tranches ≤ 300, limite API).
Précédents : `analyse-paper-session-2026-09-09.md` (J+5), `…-09-11.md` (J+7),
`…-09-13.md` (J+9,2) et `analyse-paper-couts-btc-2026-09-13.md`.
**Portée** : signaux de télémétrie uniquement (models/trading-telemetry.md) —
aucune décision, aucune transition. La confirmation de cause racine de
l'anomalie de sizing (§5) est une lecture de code, pas une mesure.

## 1. Verdict intermédiaire final avant arbitrage (delta vs 13-09)

| Axe | État | Détail |
| --- | --- | --- |
| Continuité 24/7 | **OK** | 38 342 cycles ; plus grand écart inter-cycles : toujours **2,0 min** (09-10 01:28Z) |
| Alarmes gelées | **OK (0)** | 0 `TERMINAL_FAILED` / `ORDER_OUTCOME_UNKNOWN` ; 0 `ORDER_CONFIRMED` sans exécution ; dailyPnl min **-287,73** (15-09, seuil -1 000) ; exposition «other» max 0 |
| Performance | **Négatif, stabilisé en fin de fenêtre** | 20 000 → **19 292,06 USD (-707,94, -3,54 %)** ; BTC **-693,02 (-6,93 %)**, ETH **-14,92 (-0,15 %)** ; creux **19 183,78 le 16-09 18:00Z** (drawdown -816,22, -4,08 %) |
| Rate limiting | **Plateau ~12-13 % des occurrences** | pics horaires 21-23 UTC (217-244) ; `FAILED` terminal stable ~6-7 %/jour, 0 cycle perdu |
| Latence | **Dérive confirmée** | moyenne **672,81 ms** (472,84 avant le 08-09 → **738,07** depuis) ; 2 cycles > 20 s (20,25 / 22,02 s, récupérés) |

## 2. Distribution des outcomes (38 342 cycles)

| Outcome | n | % | Lecture |
| --- | --- | --- | --- |
| `NO_ACTION` | 27 292 | 71,2 % | nominal |
| `ORDER_CONFIRMED` | 7 323 | 19,1 % | ~542 exécutions paper/jour, `executionObserved: true` 100 % |
| `FAILED` | 2 343 | 6,1 % | tous `RATE_LIMITED` (retryable) |
| `RISK_REJECTED` | 888 | 2,3 % | refus déterministes normaux |
| `ORDER_REJECTED` | 496 | 1,3 % | broker paper — **toujours 100 % BTC-USD** |

## 3. PnL par créneau et par jour (clôture UTC)

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
| 09-14 | 9 501,32 | 10 024,89 | 19 526,21 | **+157,54** |
| 09-15 | 9 195,30 | 10 006,82 | 19 202,12 | **-324,09** |
| 09-16 | 9 220,28 | 9 991,56 | 19 211,84 | +9,72 |
| 09-17 | 9 298,39 | 9 982,56 | 19 280,95 | +69,11 |
| 09-18 (05:25Z) | 9 306,98 | 9 985,08 | 19 292,06 | +11,11 |

- 9 journées négatives, 5 positives ; les 4 dernières clôtures BTC
  remontent (+111,68 depuis le creux 16-09) sur un régime volatil
  (14-09 : +180,67 intraday ; 17-09 : +103,93).
- ETH : -14,92 nets sur 13,5 j — neutre, mais pour un engagement
  structurellement ~27× plus petit que BTC (§5) : neutralité par
  sous-utilisation, pas par edge démontré (confirmé 13-09).

## 4. Décomposition coûts vs signal (fenêtre complète)

| | BTC-USD | ETH-USD |
| --- | --- | --- |
| Δ équité nette | **-693,02 USD** | -14,92 USD |
| Notional échangé cumulé | 1 158 379 USD | 44 837 USD |
| Rotations du capital | **115,8×** (≈ 8,6/j) | 4,5× |
| Fills | 3 346 (≈ 248/j) | 3 978 |
| Coûts simulés (8 bps) | **-926,70 USD** | -35,87 USD |
| **Marché/signal (brut)** | **-1 619,73 USD** | -50,79 USD |
| PnL moyen / fill (brut) | **-0,12 USD** | -0,00 USD |

1. **Le verdict clé du 18-09 est acquis : l'espérance brute par fill BTC est
   négative** (-0,12 USD avant coûts, 13,5 j, 3 346 fills). À coûts nuls, le
   créneau BTC serait à ≈ -1 620 USD (-8,1 %) — le signalement 1 min BTC est
   le problème premier, le churn (926,70 USD, 134 % du glissement net) double
   la facture.
2. **Nuance de fin de fenêtre** : jours bruts BTC 14→18-09 : +101,08 /
   -203,07 / +27,19 / +59,92 / +3,63 — 3 jours positifs sur 5 après le creux,
   sur volatilité remontée. Hypothèse de dépendance au régime (non tranchée
   par la télémétrie) à instruire côté backtest (regime-aware selector,
   models/regime-aware-selector.md) avant toute décision de mix.
3. **Journée atypique 16-09** : 216 exécutions seulement (vs ~540/j) et 0
   `ORDER_REJECTED` — le lendemain 82 rejets (15-09) puis 13 (17-09) ; le
   compte-rendu fin (§6) reste bloqué par la limite de projection AE (§5).

## 5. Anomalie de sizing ETH : cause racine confirmée dans le code

L'hypothèse du 13-09 (« taille exprimée en quantité commune plutôt qu'en
notional ») est **confirmée par lecture du code** :

- `apps/agent/src/configuration.ts` — le schéma multi-produits hérite du
  défaut `sizingPolicy: { type: "NATIVE" }` (ligne ~241) ; le `/start` du
  runbook (§3) ne passe pas de `sizingPolicy`, donc l'instance paper tourne
  en sizing natif — alors que la voie legacy mono-produit fusionne par défaut
  `LIVE_TRADING_POLICY.sizingPolicy` = `TARGET_SIGNAL_NOTIONAL` 1 000 USD.
- `apps/agent/src/strategy-registry.ts` — en `NATIVE`, toutes les stratégies
  émettent `baseSize: 0.01` **quantité** identique pour BTC et ETH :
  0,01 BTC ≈ 780 USD vs 0,01 ETH ≈ 25 USD au prix courants — rapport ≈ 30×,
  cohérent avec le rapport de fills observé (~346 USD vs ~11 USD en moyenne,
  même échelle 0,0044 unité/fill en moyenne par produit).
- **Conséquence** : la fenêtre #36 teste le mix BTC à pleine taille et le mix
  ETH à ~1/27 — les verdicts ETH de cette fenêtre seront statistiquement
  faibles. Toute correction est pour la **fenêtre suivante** (rien ne doit
  changer avant 17:01:15Z aujourd'hui) ; elle passe par une proposition
  dédiée (Model → Review → Implement → Verify), pas par la télémétrie.

## 6. Hygiène opérationnelle (fenêtre complète)

- **ORDER_REJECTED** (496, 100 % BTC) : 82 le 15-09, 0 le 16-09, 13 le 17-09,
  1 le 18-09 — non corrélé au stress PnL ; code fin toujours hors projection
  AE (limite documentée ; lecture DO nécessaire pour
  `INSUFFICIENT_CASH` vs `INSUFFICIENT_POSITION`).
- **Rate limits** : ~360-400 occurrences/jour (12-14 % des cycles), profil
  horaire plat avec pic 21-23 UTC ; auto-récupération systématique.
- **Latence** : dérive continue +265 ms en 13,5 j (472,84 → 738,07 ms en
  moyenne mobile avant/après 08-09) ; ~90 % ≤ 1 s ; 2 cycles > 20 s.
- **Couverture** : 2 817-2 872 cycles/jour (09-04 partiel : 834), aucun trou
  > 2 min.

## 7. Reste à faire avant/après l'arbitrage (17:01:15Z)

1. **À l'échéance** : rejouer `paper-session-summary-2026-09-09.mjs` et
   `paper-cost-decomposition-2026-09-18.mjs` (END_MS à ajuster à
   `2026-09-18T17:01:15Z`) pour le verdict final 14 jours exact.
2. Ne pas teardown avant l'arbitrage (runbook §6) ; la décision BTC
   (poursuite/revue du mix) appartient à l'arbitrage, instruite par une
   proposition dédiée — l'espérance brute négative (§4.1) et la dépendance
   au régime possible (§4.2) en sont les deux entrées factuelles.
3. Corrections candidates pour la fenêtre suivante, à instruire par
   propositions : sizing notional multi-produit (§5), projection du code fin
   des refus broker dans AE (§6).
