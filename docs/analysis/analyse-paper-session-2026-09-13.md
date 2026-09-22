# Analyse — Résumé de session paper 24/7 (collecte #36, point d'étape 2026-09-13)

**Fenêtre analysée** : collecte #36 valide uniquement, `2026-09-04T17:01:15Z` →
`2026-09-13T21:18Z` (~9,2 jours sur les 14 requis ; échéance d'arbitrage
2026-09-18T17:01:15Z, dans 5 jours). La fenêtre invalidée pré-#43
(16:42–17:01Z) est exclue. **Source** : Analytics Engine `dodash_paper_trading`
(SQL API, lecture seule) — 26 077 `cycle.completed` dans la fenêtre. Script :
`docs/analysis/paper-session-summary-2026-09-09.mjs` (si le token OAuth a
expiré : lancer `npx wrangler whoami` pour le rafraîchir avant).
Précèdent : `analyse-paper-session-2026-09-09.md` (J+5),
`analyse-paper-session-2026-09-11.md` (J+7).
**Portée** : signaux de télémétrie uniquement (models/trading-telemetry.md) —
aucune décision, aucune transition, aucun chiffre inventé.

## 1. Verdict intermédiaire (delta vs 11-09)

| Axe | État | Détail |
| --- | --- | --- |
| Continuité 24/7 | **OK** | 26 077 cycles (~99 % de couverture théorique) ; plus grand écart inter-cycles : toujours **2 min** |
| Alarmes gelées | **OK (0)** | 0 `TERMINAL_FAILED` / `ORDER_OUTCOME_UNKNOWN` ; 0 `ORDER_CONFIRMED` sans exécution ; dailyPnl min -191,65 (inchangé, seuil page -1 000) ; exposition «other» max 0 (seuil 20 000) |
| Performance | **Négatif, BTC en aggravation structurelle** | 20 000 → **19 379,98 USD (-620,02, -3,10 %)** — nouveau plus-bas de session ; BTC **-627,06 (-6,27 %)**, ETH **+7,04 (+0,07 %)** |
| Rate limiting | **Plateau stable ~13 %** | 12,5 % / 12,8 % / 13,3 % (11→13-09) — régime inchangé depuis le 08-09, sous la vigilance 15 % |

## 2. Distribution des outcomes (26 077 cycles)

| Outcome | n | % | Lecture |
| --- | --- | --- | --- |
| `NO_ACTION` | 18 379 | 70,5 % | comportement nominal |
| `ORDER_CONFIRMED` | 5 116 | 19,6 % | ~47 exécutions paper/jour, `executionObserved: true` à 100 % |
| `FAILED` | 1 441 | 5,5 % | tous `errorCode=RATE_LIMITED` (retryable) ; stable 6,3–6,9 %/jour depuis le 08-09 |
| `RISK_REJECTED` | 798 | 3,1 % | refus déterministes normaux |
| `ORDER_REJECTED` | 343 | 1,3 % | refus broker paper — **toujours 100 % BTC-USD**, en décélération (84 → 42 → 21 → 30/j) |

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
| 2026-09-11 | 9 548,34 | 10 018,45 | 19 566,78 |
| 2026-09-12 | 9 451,97 | 10 013,21 | 19 465,18 |
| 2026-09-13 (21:18Z) | 9 372,94 | 10 007,04 | **19 379,98** |

- **Le rebond du 11-09 s'est dissipé** : BTC a repris son glissement (9 601 →
  9 372,94), nouveaux plus-bas quotidiens les 12 et 13-09. L'hypothèse « bruit
  de mesure » du point précédent est confirmée ; la divergence BTC/ETH à
  9,2 jours (-6,27 % vs +0,07 %) a désormais une allure structurelle pour ce
  mix de stratégies sur BTC 1 min (8 des 10 journées négatives pour BTC).
- **ETH** reste résilient : au-dessus de 9 995 en clôture chaque jour,
  +7,04 cumulé, pire jour -21,16 intraday (13-09) rattrapé.
- Drawdown max combiné : **-620,02 (-3,10 %)**, atteint au point courant —
  aucun seuil de protection approché (-1 000 dailyPnl / 20 000 exposition /
  10 % drawdown).

## 4. Hygiène opérationnelle

- **Latence** : moyenne 626 ms (473 ms avant le 08-09, **713 ms depuis**) —
  dérive lente et régulière (+36 ms entre les deux derniers points), pas
  d'emballement ; ~90 % ≤ 1 s ; max 20,4 s (1 cycle, récupéré).
- **Rate limits** : plateau confirmé ~12,5–13,3 % des cycles (contre 6 % la
  première semaine). C'est le nouveau régime côté API publique Coinbase ;
  auto-récupération systématique, aucun cycle perdu.
- **Couverture** : 2 817–2 830 cycles/jour, aucun trou > 2 min sur 9,2 jours.

## 5. Anomalie `ORDER_REJECTED` (343, BTC uniquement)

+74 depuis le 11-09 (42/21/30 par jour) : **décélération** après le pic de 84
du 10-09, alors même que le créneau BTC continue de perdre — les refus ne sont
donc pas simplement proportionnels au stress PnL. Toujours exclusivement
BTC-USD, fail-closed, sans perte. Limite de télémétrie inchangée (code fin du
refus non projeté dans Analytics Engine — lecture DO nécessaire pour trancher
entre `INSUFFICIENT_CASH` et `INSUFFICIENT_POSITION`).

## 6. Avant le verdict #36 (2026-09-18T17:01:15Z)

1. Laisser courir les **5 jours restants** — ne pas teardown (runbook §6).
2. Le point clé de l'arbitrage se dessine : **fiabilité opérationnelle quasi
   parfaite** (continuité, alarmes zéro, protections jamais approchées) mais
   **divergence BTC structurellement négative**. La question du 18-09 ne sera
   plus « est-ce que ça tient ? » mais « que fait-on du créneau BTC ? »
   (revue de stratégie / sizing) — à instruire par une proposition dédiée
   (Model → Review → Implement → Verify), pas par la télémétrie.
3. Hypothèse à documenter pour l'arbitrage : coût de churn (~47 ordres/jour ×
   frais 6 bps + slippage 2 bps) — la projection `/pnl` du dashboard
   (frais et slippage constatés par cycle) permettra de chiffrer la part du
   glissement BTC imputable aux coûts vs au signalement.
   → **Fait** : voir `analyse-paper-couts-btc-2026-09-13.md` — glissement BTC
   net -627,06 = signal brut -1 288,94 + coûts simulés -661,88 ; anomalie de
   dimensionnement ETH (~27× plus petit, ≈ ratio de prix) à faire reviewer.
4. Rate limit : régime stable ~13 %, garder la vigilance 15 % pour les 5
   derniers jours.
5. À l'échéance : rejouer le script (fenêtre complète 14 j) + projection
   `/pnl` pour le verdict final et le décompte de coûts.
