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

## Revue complémentaire — DAO #62 (2026-09-26)

La valorisation paper ajoute une mesure `accountEquity` calculée sur le
portefeuille post-fill et un close daté. La qualité, le prix, la date, l’âge et
l’exposition consolidée sont exposés séparément des champs historiques du
snapshot risque. `otherExposureNotional` vaut null en télémétrie paper tant que
sa source est le stub. Aucune valeur nouvelle ne revient à `checkRisk` ou à la
machine portefeuille.

Le schemaVersion passe à 3; les blobs 1–7 et leurs sémantiques restent figés,
notamment blob6/7. Les positions supplémentaires sont append-only et leurs
sentinelles numériques disposent de bits de présence/qualité. Invariants
secrets et absence de pilotage par télémétrie inchangés.

Vérification DAO #62 : schemaVersion 3 append-only, blobs 1–7 préservés,
positions existantes conservées et nouveaux champs/presence bits couverts par
les tests de télémétrie de l’agent (suite `agent` 264/264). TypeScript réussi.
Les champs absents restent distinguables de zéro; aucune donnée telemetry
n’alimente le modèle de risque ou une transition.

## Review — 2026-09-28 amendment

Approved. Additive event type only; blobs 1–10 and doubles 1–18 keep their
meaning. No threshold of the frozen live alerts changes.
