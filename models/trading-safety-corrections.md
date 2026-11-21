# Corrections de sûreté du runtime et des protections

Statut : normatif (2026-11-21).

## Constat

L'audit local reproduit un ordre après `stop`/`kill`, une clôture protectrice bloquée par le risque consolidé, un trailing oublié avec la fenêtre marché, des shorts masqués et une protection inventée par le dashboard. Les frais short ont été corrigés par v7 ; ce comportement doit rester couvert.

## Propriétaire unique et événements

Le shell maintient une exécution active par créneau (`single` ou produit). Les réveils concurrents rejoignent sa promesse. `STOP_REQUESTED` et `KILL_SWITCH_ENGAGED` vont immédiatement au même acteur `tradingCycleMachine` que l'interpréteur. La commande attend le drainage au lieu de lancer un second interpréteur. Tous les produits reçoivent le contrôle avant l'attente de drainage. Le propriétaire est libéré dans un `finally`, même sur erreur.

Avant soumission, le contrôle suit `cancelling → persisting → stopped/halted`. Pendant une soumission possible, il suit `reconcilingOrder → persisting`, puis le drainage existant. Un contrôle arrivé après le dernier effet est drainé après la fin de l'exécution active. L'état publié est celui de l'acteur partagé. `failed` et `halted` restent stables jusqu'à `RESET`. Les appels réseau restent des effets ; aucun LLM ni texte libre ne choisit une transition.

## Protection paper persistée

Le cœur pur `resolvePaperPositionProtection(previous, input) → PaperPositionProtection | null` porte `side`, `averagePrice`, `enteredAt`, `extremePrice`, `stopLossPrice` et `takeProfitPrice`. Son identité est `(side, averagePrice, enteredAt)`. Pour la même position, il conserve le meilleur extrême et le stop le plus protecteur, même si l'ATR augmente. Il reprend les seuils v7 sans les recalibrer. Une position plate donne `null` ; une nouvelle entrée initialise son propre plan.

En `allocating`, l'événement typé `PAPER_PROTECTION_UPDATED` enregistre le plan dans le contexte XState et les artefacts avant l'exécution. La machine transporte ces faits sans calcul de trading. Un champ legacy absent ou invalide se normalise à `null`. La restauration et le stop/start portefeuille conservent le plan de la position portée ; `RESET` l'efface.

## Réductions d'exposition consolidées

`RISK_PROPOSED` peut porter les quantités courante et projetée. La garde classe comme réduction une diminution stricte de la quantité absolue, sans inversion de signe ; une clôture à zéro est une réduction. Les propositions legacy sans quantités utilisent uniquement une diminution stricte de l'exposition rapportée. Une réduction valide d'un produit connu et actif passe les plafonds de perte et d'exposition consolidés, même si d'autres produits restent au-dessus du plafond. Le kill switch et les états de produit restent prioritaires.

Le cœur pur `evaluatePortfolioRisk` applique la même sémantique à partir des ordres et positions validés. Les augmentations restent soumises aux deux plafonds ; un ordre sans intention reste `NO_ORDER`. Les montants invalides ou une inversion ne donnent aucune exemption. Aucun booléen fourni par un effet ne décide qu'un ordre réduit la position.

## Projection et affichage

Une quantité signée non nulle désigne une position ouverte. La sélection consolidée reconnaît LONG et SHORT ; l'échelle stop/entrée/take-profit accepte les deux orientations. Le dashboard ne fabrique jamais de niveau ni de confirmation. Une protection d'historique ne s'applique à un produit sélectionné que si son identité, son sens, sa quantité et son prix moyen correspondent. Faute de fait compatible : « NON PROTÉGÉ ».

La projection d'historique reconnaît les protections des ouvertures LONG et SHORT, efface les protections d'une position close et consomme les plans paper datés des artefacts pour la position correspondante. Une protection paper calculée n'est jamais une confirmation d'ordre protecteur d'exchange. L'absence de données reste explicite.

## Invariants

1. Un seul interpréteur actif par créneau ; une commande pré-soumission empêche toute soumission ultérieure de ce cycle.
2. La fin d'un effet ancien ne réactive pas un agent arrêté ; une soumission possible est réconciliée avant arrêt.
3. Le stop LONG ne baisse jamais et le stop SHORT ne monte jamais pour une même position.
4. Les extrêmes et stops survivent aux checkpoints, restaurations et fenêtres glissantes ; ils ne passent pas à une autre position.
5. Une réduction ne peut être empêchée par un plafond financier ; kill switch, permissions et produit actif restent requis.
6. Le dashboard ne masque pas un short et n'invente aucune protection ni confirmation.
7. Après clôture complète, le PnL réalisé LONG/SHORT égale la variation du cash, frais inclus, à la précision flottante près.

## Vérification requise

- Stop/kill pendant fetch, allocation ou autorisation : aucune nouvelle soumission, état terminal maintenu.
- Contrôle pendant soumission : réconciliation puis drainage ; réveils concurrents : un seul effet ; erreur : propriétaire libéré.
- Contrôle portefeuille : chaque produit reçoit l'événement et les produits terminaux ne redémarrent pas.
- LONG/SHORT : extrême sorti de fenêtre, ATR croissant, restauration, stop/start, position plate et nouvelle entrée.
- Risque local et consolidé : clôtures LONG/SHORT et réductions partielles malgré pertes/plafond, augmentations et inversions refusées, kill prioritaire.
- Dashboard : short visible, échelle orientée correctement, absence de protection, produit différent, plans short et absence de fausse confirmation.
- Aller-retour short avec frais : PnL égal au delta de cash.
