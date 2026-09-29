# Planification des réveils de cycle — alignement sur la grille et décision manquée

Statut : normatif (2026-09-28).

## 1. Constat

`scheduleEvery(intervalSeconds)` du SDK `agents` re-programme l'échéance
suivante à `fin d'exécution + intervalle` : l'heure de réveil dérive d'environ
50 s par jour (16:54:58 le 19-09 → 06:01:54 le 28-09). Pour une politique
`ONE_DAY` à fraîcheur 2 h, la fenêtre de décision est `[00:00, 02:00[` UTC et ne
contient que deux réveils ; la dérive déplace le premier réveil de 1 à 59 min
après la clôture selon la semaine.

## 2. Résolution pure

```ts
resolveCycleSchedule(intervalSeconds) →
  | { kind: "cron"; expression: string; intervalSeconds }
  | { kind: "interval"; intervalSeconds }
```

- `cron` si `intervalSeconds` est un entier multiple de 60 qui divise 86 400 ;
  décalage `SCHEDULE_OFFSET_MINUTES = 1` si `intervalSeconds ≥ 600`, sinon 0
  (laisser Coinbase publier la bougie close ; sous 10 min, le décalage
  minute n'a pas de sens).
  - 60 → `* * * * *` ; 300 → `*/5 * * * *` ;
    600 → `1,11,21,31,41,51 * * * *` ;
    900 → `1,16,31,46 * * * *` ; 1 800 → `1,31 * * * *` ; 3 600 → `1 * * * *` ;
    21 600 → `1 */6 * * *` ; 86 400 → `1 0 * * *`.
- `interval` sinon (comportement actuel, `scheduleEvery`).

`AgentScheduleState` devient `{ id, intervalSeconds, kind, expression? }`. Un
état legacy sans `kind` est traité comme `interval` et ré-armé au prochain
passage en `scheduling` (effet `ensureSchedule`, idempotent) : l'ancienne
planification est annulée avant la nouvelle.

## 3. Décision manquée

Pour un cycle déclenché à `T` avec granularité `D` et fraîcheur `S` :
`decisionCandleClosedAt = floor(T / D) × D`. La décision est **manquée** quand
le cycle se termine avec `T − decisionCandleClosedAt > S` et
`lastDecisionCandleClosedAt < decisionCandleClosedAt` (ou nul). Effet : un
événement télémétrie `decision.missed` (schéma 3, `outcome =
DECISION_WINDOW_MISSED`, `errorCode` = dernière erreur du cycle) et une
notification opérateur `DECISION_WINDOW_MISSED`, une seule fois par bougie :
`lastMissedDecisionCandleClosedAt` est persisté par produit et normalisé à
`null` à la restauration. L'événement est une projection ; il ne change aucune
transition. Les champs de valorisation restent identiques à ceux du
cycle terminé, y compris les valeurs nulles et le masque de présence. La
clôture de la bougie manquée est portée par le log structuré
`decision_window_missed`, jamais par `valuationObservedAt`.

## 4. Invariants

1. L'alignement ne modifie ni l'intervalle configuré ni la politique validée.
2. Un réveil aligné et un réveil legacy ne coexistent jamais pour la même
   instance.
3. Une décision manquée est signalée une fois, au plus tard au premier cycle
   terminé après la fenêtre.
4. Aucune décision de trading n'est prise à partir de l'alerte.

## 5. Vérification requise

- Table d'expressions ci-dessus ; 90 s et 7 s → `interval`.
- Ré-armement legacy → cron : ancienne planification annulée, nouvelle persistée.
- Décision manquée : émise à 03:00 après échecs 00:00 et 01:00 ; non émise si
  une décision existe pour la bougie ; une seule émission par bougie ; aucune
  émission pendant la fenêtre.
