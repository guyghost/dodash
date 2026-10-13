# Admission de bougie observable — modèle du 13 octobre 2026

Statut : normatif, modélisé et revu avant implémentation. Source : diagnostic disponibilité marché.
Périmètre : mesure, aucune nouvelle garde de trading ni transition.

## Fait durable

Le contexte XState gagne `marketAdmission: MarketAdmission | null`, avec
`{ cycleId, candleClosedAt, evaluatedAt }`. Seule l'action `recordMarketData`,
sur la transition fraîche `fetchingMarketData → computingIndicators`, écrit
ce fait depuis `MARKET_DATA_READY`. La persistance existante de la machine
précède tout calcul. Une admission n'est ni une stratégie évaluée avec succès,
ni une approbation de risque, ni un ordre.

- Initialisation, START, nouvelle alarme et RESET : fait null.
- Bougie dupliquée ou périmée : aucun nouveau fait.
- Reprise du même cycle : fait conservé, pas de nouvel instant d'admission.
- Restauration legacy : null, jamais reconstitué depuis un mark ou une issue.
- Fait invalide : normalisé vers null. Identité égale au cycle du contexte,
  close égal à `lastDecisionCandleClosedAt`, horodatages entiers sûrs,
  `close ≤ trigger ≤ evaluatedAt`, âge inférieur ou égal au seuil du contexte.
- Ce champ n'est lu par aucune garde, stratégie, allocateur ou moteur de risque.

## Télémétrie version 4

Les deux producteurs `cycle.completed` (mono-produit et portefeuille) publient
le contexte observé après persistance : `cycleId`, `triggeredAt`,
`decisionAdmissionStatus`, `decisionCandleClosedAt`, `decisionEvaluatedAt`.

Statuts fermés :

- `ADMITTED` : fait durable valide ; close et instant d'évaluation présents.
- `UNOBSERVED` : fait absent/invalide/legacy ; ne prouve **pas** une absence
  d'admission et ne constitue pas une décision manquée.
- `MISSED` : uniquement `decision.missed`, close original fourni par
  `resolveMissedDecision`, jamais déduit de l'heure d'émission ou du mark.
  `decisionEvaluatedAt = null`.

La projection legacy version 3 reste identique pour contrôle/preflight et
ses lecteurs existants. Les premiers 10 blobs et 18 doubles sont figés.
La version 4 ajoute :

| Position | Valeur |
| --- | --- |
| blob11 | cycleId ou `NONE` |
| blob12 | triggeredAt décimal en ms ou `NONE` |
| blob13 | statut d'admission |
| double19 | close admis/manqué, zéro sentinelle si `UNOBSERVED` |
| double20 | evaluatedAt, zéro sentinelle si `UNOBSERVED`/`MISSED` |

Les horodatages valides peuvent valoir zéro : le statut indique la présence.
Le trigger est encodé en blob pour respecter la limite officielle de 20 doubles
par point AE : https://developers.cloudflare.com/analytics/analytics-engine/limits/
Les enregistrements JSON utilisent null pour les absences.

## Mesure de couverture

Dédupliquer les lignes `cycle.completed`, version 4, `ADMITTED` par
`(agent, produit, close)` ; un même cycle repris peut publier plusieurs fois le
même fait. Utiliser `decisionEvaluatedAt` pour la fenêtre de fraîcheur, pas la
fin du cycle. Compter les `MISSED` par leur close original séparément.

AE reste échantillonné et son écriture peut échouer sans influer le workflow :
les admissions **observées sont exactes**, mais leur absence et le total réel
ne le sont pas. Sans ledger durable complet lu séparément, le taux d'admissions
observées reste une borne inférieure, jamais une preuve de zéro admission.
Les versions 3 ne sont pas reclassées comme admissions version 4.

## Vérification requise

Tests machine : fait enregistré uniquement sur admission, conservé en reprise,
effacé par nouvelle alarme/reset, aucun fait pour stale ou doublon.
Tests restauration : absence et données incohérentes → null.
Tests télémétrie : layout legacy inchangé, 13 blobs/20 doubles en v4, passage
de minuit correct pour `MISSED`, aucune exception de sink dans le workflow.
Tests shell mono/portefeuille : publication depuis le contexte, pas le mark.

La comparaison shadow depuis Cloudflare reste un lot séparé : pas de nouveau
Worker ni changement de fournisseur dans cette implémentation.
