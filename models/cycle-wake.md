# Réveil de grille pendant un cycle — modèle du 13 octobre 2026

Statut : normatif, modélisé et revu avant implémentation. Source : audit paper, F2.

## Événements et séquence

Un réveil avec `triggerAlarm=true` est distinct du cycle déjà en cours.
`planCycleWake(phase, triggerAlarm)` décide purement :

- `waiting` + grille : interpréter une nouvelle alarme immédiatement ;
- autre phase + grille : reprendre sans alarme, puis conserver une demande
  de nouvelle alarme pour la fin de **cet appel** ;
- contrôle/retry (`triggerAlarm=false`) : reprendre seulement.

Après reprise, `shouldStartPendingCycle(plan, latestPhase)` autorise une seule
nouvelle invocation si une alarme est en attente et l'état courant est
`waiting`. L'interpréteur ne rejoue jamais une alarme à l'identité du cycle
repris. `ALARM_FIRED` reste la seule transition vers un nouveau cycle.

## Effets et invariants

1. Le shell termine les effets, la projection d'état, la télémétrie et
   `decision.missed` du cycle repris **avant** la nouvelle invocation.
2. La nouvelle invocation reçoit un nouveau UUID et l'heure courante ;
   l'identité, les artefacts et l'heure du cycle repris restent inchangés.
3. La machine conserve `lastDecisionCandleClosedAt` : si la nouvelle invocation
   reçoit la même bougie, `NO_ACTION`, sans nouvel indicateur ni ordre.
4. Un état toujours en retry, `stopped`, `halted` ou `failed` ne démarre rien.
   Le shell relit l'état courant après ses effets avant de demander la suite.
5. Le portefeuille ne relance que le produit repris, avec sa projection déjà
   committée. Aucun cycle d'un autre produit ni déplacement du schedule partagé.
6. La suite est bornée : démarrant en `waiting`, la seconde invocation ne porte
   pas de demande différée. Pas de boucle de rattrapage.

Pas de nouveau contexte XState ni migration SQLite. La demande n'est pas
persistée si la reprise reste en attente ou si le DO s'interrompt entre les
deux invocations : le prochain réveil de grille reprend la progression.
Ce lot ne garantit pas le rattrapage de chaque tick perdu sur crash.

## Vérification

- Reprise terminée par un tick de grille : aucun `DUPLICATE_ALARM` interne.
- Deux cycles distincts et deux issues persistées, ordre de publication stable.
- Même bougie : aucune seconde décision/exécution.
- Ancien cycle expiré puis nouvelle bougie : deux issues distinctes.
- Retry non échu, alarme ponctuelle, stop/kill : aucun nouveau cycle.
- Vérification mono-produit et portefeuille, avec horloge contrôlée.
