# Revue — fidélité dailyPnl du replay

Verdict : **APPROUVÉ** (3 notes, 0 bloqueur).

## Couverture du modèle

- Cas nominaux : fenêtre roulée chaque candle, reset au changement de
  jour UTC, dailyPnl passé au snapshot. ✓
- Cas erreurs : aucun nouveau chemin d'erreur (résolveur pur existant,
  immunisé par ses propres tests). ✓
- Annulations/retries : non applicables (replay déterministe mono-run). ✓
- Permissions : hors périmètre explicite (§8). ✓
- États terminaux : la fenêtre vit et meurt avec le run, pas d'état
  terminal dédié. ✓
- Aucune transition pilotée par LLM ou texte libre. ✓

## Vérifications code (à faire à l'implémentation)

1. **V1** — `equityBefore` (L699) n'a que l'usage `dailyPnl` L706 :
   après remplacement, supprimer la variable si orpheline (grep
   d'usages dans la boucle).
2. **V2** — Placement : résoudre la fenêtre **après** `allocation.ok`
   et **avant** la boucle d'ordres, inconditionnellement à chaque
   candle évalué. `equityCandle` doit refléter le portfolio post-
   exécution des pendings (vérifier que la résolution se situe après
   l'exécution à l'open — miroir du live qui marque après le cycle
   précédent).
3. **V3** — Le snapshot `now: resolveRiskEvaluationTimestamp(...)`
   reste inchangé ; la fenêtre est résolue sur `candle.start`
   (horloge marché), pas sur `now` (horloge d'évaluation décalée par
   cooldown). Documenté dans le test si visible.
4. **V4** — Test de caractérisation (verrou de comportement) :
   dataset journalier synthétique, BUY à deux jours distincts, chute
   de prix entre les deux, `maxDailyLoss` serré (ex. 100 $) :
   - attendu nouveau comportement : 2 trades, aucun
     `DAILY_LOSS_LIMIT` dans les diagnostics ;
   - l'ancien comportement (cumul) n'aurait exécuté qu'1 trade —
     le test fige la sémantique quotidienne, pas le cumul.
5. **V5** — Campagne D2'' : 10 fenêtres × 4 profils pré/post (stash),
   diff bit-à-bit de toutes les métriques + reasonCodes. Tout écart =
   INVALIDE.
6. **V6** — Vérifier qu'aucun autre test backtest ne dépend du
   dailyPnl cumulatif (grep `dailyPnl` dans test/) — adapter si besoin.

## Notes (non bloquantes)

- **N-P1** : les candles en warm-up (snapshots indicateurs null) qui
  n'atteignent pas le point de résolution ne roulent pas la fenêtre.
  Sans effet en ONE_DAY (reset quotidien → INV-P3) ; à trancher si un
  timeframe infra-journalier arrive (le live roule pendant le warm-up).
- **N-P2** : le marquage `openingEquity` à la première évaluation du
  jour (close du candle) diffère de l'open réel — documenté §8, miroir
  assumé du live (qui marque au premier cycle du jour, pas à minuit).
- **N-P3** : INV-P4 repose sur `maxDailyLoss > 0` dans toutes les
  configs de campagne (vérifié : V1 = 1 000, harnais tests = 5 000 /
  100). Une config `maxDailyLoss = 0` rendrait `0 ≤ −0` vrai →
  rejet systématique ; aucun consumer ne l'utilise.

## Risques acceptés

- **R1** : perte d'information — le replay ne expose plus le PnL cumulé
  au risk engine ; aucun consumer n'en dépendait (grep V1).
