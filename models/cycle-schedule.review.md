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
