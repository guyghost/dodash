# Analyse — Résumé de session paper 24/7 (collecte #36, point d'étape 2026-09-11)

**Fenêtre analysée** : collecte #36 valide uniquement, `2026-09-04T17:01:15Z` →
`2026-09-11T14:18Z` (~6,9 jours sur les 14 requis ; échéance d'arbitrage
2026-09-18, dans 7 jours). La fenêtre invalidée pré-#43 (16:42–17:01Z) est
exclue. **Source** : Analytics Engine `dodash_paper_trading` (SQL API, lecture
seule) — 19 594 `cycle.completed` dans la fenêtre. Script reproductible :
`docs/analysis/paper-session-summary-2026-09-09.mjs` (`CF_OAUTH=<token> node …`).
Précède : `analyse-paper-session-2026-09-09.md` (point à J+5).
**Portée** : signaux de télémétrie uniquement (models/trading-telemetry.md) —
aucune décision, aucune transition, aucun chiffre inventé.

## 1. Verdict intermédiaire (delta vs 09-09)

| Axe | État | Détail |
| --- | --- | --- |
| Continuité 24/7 | **OK** | 19 594 cycles (~98,8 % de couverture théorique) ; plus grand écart inter-cycles : **2 min** (09-10 01:28Z) |
| Alarmes gelées | **OK (0)** | 0 `TERMINAL_FAILED` / `ORDER_OUTCOME_UNKNOWN` ; 0 `ORDER_CONFIRMED` sans exécution ; dailyPnl min **-191,65** (seuil page -1 000) ; exposition «other» max 0 (seuil 20 000) |
| Performance | **Négatif, en aggravation puis rebond** | 20 000 → **19 618,61 USD (-381,39, -1,91 %)** ; BTC **-398,72 (-3,99 %)**, ETH **+17,33 (+0,17 %)** ; creux combiné **19 478,60** le 11-09 11:00Z (drawdown -521,40) puis **rebond net le 11-09** |
| Rate limiting | **Plateau élevé ~13 %** | 368/j (09-09), 365/j (09-10), ~12 % (11-09) — stabilisé sous le seuil de vigilance 15 %, latence moyenne 689 ms |

## 2. Distribution des outcomes (19 594 cycles)

| Outcome | n | % | Lecture |
| --- | --- | --- | --- |
| `NO_ACTION` | 13 791 | 70,4 % | comportement nominal |
| `ORDER_CONFIRMED` | 3 891 | 19,9 % | ~47 exécutions paper/jour, `executionObserved: true` à 100 % |
| `FAILED` | 1 005 | 5,1 % | tous `errorCode=RATE_LIMITED` (retryable) ; stabilisé ~6,5–7 %/jour depuis le 08-09 |
| `RISK_REJECTED` | 638 | 3,3 % | refus déterministes normaux |
| `ORDER_REJECTED` | 269 | 1,4 % | refus broker paper — **toujours 100 % BTC-USD**, cf. §5 |

## 3. PnL et équité par créneau (10 000 USD/créneau)

| Jour UTC (clôture) | BTC-USD | ETH-USD | Total |
| --- | --- | --- | --- |
| 2026-09-04 | 9 999,60 | 9 999,76 | 19 999,36 |
| 2026-09-05 | 9 953,03 | 9 999,53 | 19 952,55 |
| 2026-09-06 | 9 919,13 | 10 001,28 | 19 920,41 |
| 2026-09-07 | 9 784,14 | 10 001,09 | 19 785,24 |
| 2026-09-08 | 9 696,05 | 10 003,59 | 19 699,64 |
| 2026-09-09 | 9 644,57 | 10 001,26 | 19 645,83 |
| 2026-09-10 | 9 553,29 | 9 995,50 | 19 548,79 |
| 2026-09-11 (14:18Z) | 9 601,28 | 10 017,33 | **19 618,61** |

- **BTC** : poursuite du glissement jusqu'au 10-09 (pire jour : dailyPnl min
  intraday **-191,65**), puis **rebond de +148 USD le 11-09** (equity
  9 480,93 → 9 601,28 en 3 h) — plus gros gain journalier de la session.
- **ETH** : premier jour négatif le 10-09 (clôture 9 995,50, min intraday
  -15,78) puis **record de session le 11-09 à 10 017,33** (+17,33 cumulé).
- Drawdown max combiné : **-521,40 (-2,61 %)** le 11-09 11:00Z — aucun seuil de
  protection approché (-1 000 dailyPnl / 20 000 exposition / 10 % drawdown).

## 4. Hygiène opérationnelle

- **Latence** : moyenne 585 ms (473 ms avant le 08-09, **689 ms depuis**) ;
  ~92 % ≤ 1 s ; max 20,4 s (1 cycle, transcendé et récupéré). La dégradation
  se stabilise : la moyenne « depuis 09-08 » passe de 653 ms (au 09-09) à
  689 ms (au 11-09) — dérive lente, pas d'emballement.
- **Rate limits** : montée 6,0 % → 13,0 % (09-09) puis **plateau** :
  12,9 % (09-10), ~12,0 % (11-09 partiel). Profil horaire uniforme (64–104/h)
  : toujours pas de créneau coupable ; le régime semble s'être stabilisé à un
  nouveau palier (côté quota API publique Coinbase), sous le seuil de
  vigilance 15 % fixé au point précédent.
- **Couverture** : ~2 830 cycles/jour constants, aucun trou > 2 min.

## 5. Anomalie `ORDER_REJECTED` (269, BTC uniquement)

Progression : 22 → 50 → 52 → 42 → **84** (pic 10-09) → 19 (11-09 partiel).
Toujours exclusivement BTC-USD, première occurrence 2026-09-06 08:44Z. Refus
déterministes du broker paper (`INSUFFICIENT_CASH` / `INSUFFICIENT_POSITION` /
`INVALID_MARKET_PRICE` — fail-closed, sans perte). Le pic du 10-09 coïncide
avec le pire jour BTC : les refus sont corrélés aux phases de stress du
créneau (signaux successifs sur cash/position tendus). **Limite de télémétrie
inchangée** : le code fin du refus n'est pas projeté dans Analytics Engine ;
lecture DO (`dodash_orders` via `/api/agents/btc-usd-paper/cycles`) nécessaire
pour trancher — candidat enrichissement télémétrie si arbitrage.

## 6. Avant le verdict #36 (2026-09-18)

1. Laisser courir les **7 jours restants** — ne pas teardown (runbook §6).
2. Rate limit : palier ~13 % observé, sous la vigilance 15 % — re-vérifier la
   tendance au prochain point (si > 15 % durable, investiguer le quota).
3. Le rebond du 11-09 (BTC +148, ETH record) montre la volatilité de la
   mesure à 7 jours : le verdict final doit se prononcer sur la fenêtre
   complète 14 j, pas sur un sous-ensemble.
4. À l'échéance : rejouer le script (fenêtre complète) + projection `/pnl`
   (frais, slippage constatés) via l'API dashboard pour l'arbitrage.
5. Décisions de fond (stratégie BTC, churn ~47 ordres/jour vs frais 6 bps +
   slippage 2 bps) : hors périmètre télémétrie — proposition dédiée si
   l'arbitrage #36 le demande.
