# Revue — planification des réveils et décision manquée (2026-09-28)

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**.

- La résolution est pure ; les seuls chiffres sont la table cron dérivée de
  l'intervalle configuré et un décalage d'une minute au-delà de 600 s.
- Le ré-armement legacy est porté par l'effet `ensureSchedule` déjà appelé à
  chaque cycle (phase `scheduling`) et par `onStart` : aucune commande opérateur
  n'est nécessaire pour migrer l'instance déployée.
- `decision.missed` réutilise la projection AE positionnelle du schéma 3 ; la
  distinction se fait sur `blob1`. Les alertes live gelées de
  `trading-telemetry.md` ne changent pas ; la classe opérateur ajoutée est
  documentée dans `operator-notifications.md`.
- Limite acceptée : la série de 429 ≥ 6 h est une requête AE de supervision
  (hors Durable Object), comme `NO_LIVE_CYCLE`.

## Revue des corrections PR #20 (2026-09-30)

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**.

- Les intervalles sous une heure de 600 s ou plus doivent énumérer les
  minutes de grille avec le décalage de 1 min ; les pas de 10, 15, 20 et
  30 min divisent une heure et conservent leur cadence.
- La projection `decision.missed` ne modifie que type, timestamp et outcome.
  Toutes les métadonnées de valorisation et leur présence AE restent celles
  du cycle source ; tester une valorisation absente et une valorisation datée.
- Aucun nouvel événement de machine, transition ou effet de trading.

## Revue de l'amendement du 2026-10-07

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**.

- Évaluation de la fenêtre à `completedAt` : aucune double émission
  (`lastMissedDecisionCandleClosedAt` monotone), aucune émission prématurée
  (`N ≤ T + S` ⇒ fenêtre ouverte). `completedAt` est obligatoire pour qu'aucun
  appelant ne retombe sur `T`.
- Décalage inter-produits : section dédiée (§4), réveils de grille seulement ;
  les retries restent non décalés (limite acceptée côté `market-retry-schedule`).
- Aucun nouvel événement de machine, transition ou effet de trading.
- Revue d'implémentation (2026-10-07) : décalage limité à `scheduledTick`
  (pas de réponse HTTP `runNow` retenue), produits désactivés sans attente,
  état relu après l'attente.
