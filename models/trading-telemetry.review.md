# Trading telemetry review

Reviewed: 2026-08-23

Decision: approved for implementation and synthetic alert verification.

- Nominal cycle, preflight and control outcomes have bounded typed fields.
- Error, unknown-order, reconciliation, exposure, PnL and liveness signals are
  represented without free-text transition logic.
- Analytics failure is isolated from trading; deployment admission owns sink
  availability.
- No credential or request payload field is permitted.
- Production remains forbidden until real alert destinations, health probes and
  the on-call owner are externally verified.

## Revue complémentaire — amendement dao #47 (2026-09-19)

L'amendement ajoute blob7 (code fin des refus broker) à la projection
Analytics Engine et fait passer les enregistrements en schema version 2.
Le transport — champ diagnostique optionnel `WorkflowError.detail` rempli à
la couture d'exécution paper (`paperRejectionError`), lu uniquement quand
blob6 vaut `ORDER_REJECTED` — est vérifié dans le code : la machine range
l'erreur d'événement telle quelle dans `context.lastError` (`recordError`),
aucun état, événement ou transition n'est modifié ; blob6 reste le code
`WorkflowError` fermé, jamais surchargé ; le vocabulaire blob7 est l'union
fermée de `packages/paper-execution`. Les enregistrements control/preflight
portent `NONE`. Aucun secret ni texte libre supplémentaire n'entre en
télémétrie (invariants 1-4 inchangés).

Amendement approuvé en revue.
