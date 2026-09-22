# Analyse — Résumé de session paper 24/7 (collecte #36, point d'étape 2026-09-09)

**Fenêtre analysée** : collecte #36 valide uniquement, `2026-09-04T17:01:15Z` →
`2026-09-09T15:20Z` (~4,93 jours sur les 14 requis ; échéance d'arbitrage
2026-09-18). La fenêtre invalidée pré-#43 (16:42–17:01Z) est exclue.
**Source** : Analytics Engine `dodash_paper_trading` (SQL API, lecture seule) —
14 065 `cycle.completed` dans la fenêtre. Script reproductible :
`docs/analysis/paper-session-summary-2026-09-09.mjs` (`CF_OAUTH=<token> node …`).
**Portée** : signaux de télémétrie uniquement (models/trading-telemetry.md) —
aucune décision, aucune transition, aucun chiffre inventé.

## 1. Verdict intermédiaire

| Axe | État | Détail |
| --- | --- | --- |
| Continuité 24/7 | **OK** | 14 065 cycles (~2 860/jour attendus) ; plus grand écart inter-cycles : **2 min** (2026-09-08 17:31Z) |
| Alarmes gelées | **OK (0)** | 0 `TERMINAL_FAILED` / `ORDER_OUTCOME_UNKNOWN` ; 0 `ORDER_CONFIRMED` sans exécution observée ; dailyPnl min -184,30 (seuil page -1 000) ; exposition «other» max 0 (seuil 20 000) |
| Performance | **Négatif (portefeuille)** | 20 000 → **19 694,01 USD (-305,99, -1,53 %)** ; créneau BTC **-310,52 (-3,11 %)**, créneau ETH **+4,53 (+0,05 %)** |
| Dégradation à surveiller | **Oui** | cycles `FAILED` (rate limit) 6,0 % → **11,6 %** des cycles entre le 05 et le 08-09 ; latence moyenne 473 → 653 ms |

## 2. Distribution des outcomes (14 065 cycles)

| Outcome | n | % | Lecture |
| --- | --- | --- | --- |
| `NO_ACTION` | 10 073 | 71,6 % | comportement nominal (aucun signal) |
| `ORDER_CONFIRMED` | 2 635 | 18,7 % | ~44 exécutions paper/jour, `executionObserved: true` à 100 % |
| `FAILED` | 629 | 4,5 % | tous `errorCode=RATE_LIMITED` (retryable, phase market-data) |
| `RISK_REJECTED` | 569 | 4,0 % | refus déterministes normaux (cooldown / côté sans position) |
| `ORDER_REJECTED` | 159 | 1,1 % | refus du broker paper — **100 % BTC-USD**, cf. §5 |

## 3. PnL et équité par créneau (10 000 USD/créneau)

| Jour UTC (clôture) | BTC-USD | ETH-USD | Total |
| --- | --- | --- | --- |
| 2026-09-04 | 9 999,60 | 9 999,76 | 19 999,36 |
| 2026-09-05 | 9 953,03 | 9 999,53 | 19 952,55 |
| 2026-09-06 | 9 919,13 | 10 001,28 | 19 920,41 |
| 2026-09-07 | 9 784,14 | 10 001,09 | 19 785,24 |
| 2026-09-08 | 9 696,05 | 10 003,59 | 19 699,64 |
| 2026-09-09 (15:20Z) | 9 689,48 | 10 004,53 | **19 694,01** |

- Trajectoire : glissement continu du créneau BTC dès le 05-09, creux combiné
  **19 692,37 USD** le 2026-09-09 ~12:00Z (drawdown -307,63) ; ETH quasi plat.
- Worst day BTC : 09-08 (dailyPnl min intraday **-184,30**) ; le 09-09 a vu un
  rebond intraday (dailyPnl max +26,61) avant de retomber (-23,71 à 15:20Z).
- dailyPnl min absolu -184,30 : **aucun** seuil de protection approché
  (-1 000), aucune page.

## 4. Hygiène opérationnelle

- **Latence** : min 186 ms / moyenne 532 ms / max 20,4 s (1 cycle aberrant) ;
  p50 ≈ 250–500 ms, ~92 % ≤ 1 s. Dégradation nette depuis le 08-09
  (473 → 653 ms en moyenne), corrélée à la hausse des rate limits.
- **Rate limits** : progression quotidienne 6,0 % (05) → 7,5 % (06) → 8,1 % (07)
  → **11,6 %** (08, confirmé le 09). Profil horaire uniforme (36–66/h) : pas de
  créneau coupable identifiable ; c'est une tendance globale côté API publique
  Coinbase. Aucun cycle perdu (auto-récupération), mais la tendance justifie le
  point ouvert n°2 du runbook.
- **`control.completed` : 1** — le stop/reconfiguration dao #43 ; cohérent.

## 5. Anomalie `ORDER_REJECTED` (159, BTC uniquement)

Première occurrence : **2026-09-06 08:44Z**, puis 22/50/52/35 par jour. En
paper, ce refus vient d'`executePaperOrder` (packages/paper-execution) :
validation déterministe du broker (`INSUFFICIENT_CASH`, `INSUFFICIENT_POSITION`,
`INVALID_MARKET_PRICE`…) — comportement fail-closed correct, sans perte. La
concentration sur BTC (créneau en glissement) suggère des refus de type cash/
position insuffisante sur des signaux successifs. **Limite de télémétrie** : le
code de refus fin du broker n'est pas projeté dans Analytics Engine (blob6 ne
porte que `ORDER_REJECTED`) — le détail exact exigerait une lecture DO
(`dodash_orders` via `/api/agents/btc-usd-paper/cycles`). Candidat à une
proposition d'enrichissement télémétrie si l'arbitrage #36 le demande.

## 6. Ce qui reste avant le verdict #36 (2026-09-18)

1. Laisser courir la collecte (9 jours restants) — ne pas teardown (runbook §6).
2. Surveiller la tendance rate-limit/latence ; si les `FAILED` dépassent
   durablement ~15 %, investiguer le quota API publique Coinbase.
3. À l'échéance : rejouer ce script sur la fenêtre complète pour le verdict,
   avec en complément la projection `/pnl` (frais, slippage constatés, courbe
   d'équité fine) via l'API dashboard.
4. Décisions de fond (stratégies BTC vs ETH, churn ~44 ordres/jour vs frais
   6 bps + slippage 2 bps) : hors périmètre télémétrie — à instruire via une
   proposition dédiée (Model → Review → Implement → Verify).
