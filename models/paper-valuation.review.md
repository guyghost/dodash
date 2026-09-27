# Revue normative — valorisation paper datée (DAO #62)

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE** après les décisions
documentées dans `paper-valuation.md`. Cette revue ne permet ni déploiement ni
activation live.

## Décisions de modèle

- Le prix est un close Coinbase de la dernière bougie acceptée. Le timestamp
  vient de `candle.start + TIMEFRAME_MILLISECONDS[timeframe]`; le cycle garde
  séparément `asOf` et la limite de fraîcheur observée.
- La qualité se calcule à la lecture. Il n’y a pas de nouveau cycle de vie ni
  transition XState; le snapshot de mark est une donnée de mesure mise à jour
  uniquement après `MARKET_DATA_READY`.
- `averagePrice` reste le coût d’acquisition. Il n’est jamais converti en mark,
  même après restauration d’un état legacy.
- Un mark périmé conserve une valeur explicitement stale. Sans mark et avec une
  position ouverte, equity et exposition sont nulles (absence); quantité nulle
  permet de rapporter le cash connu sans marque.
- Le portefeuille après fill est valorisé avec le mark courant. Les frais sont
  déjà inclus dans cash; le projecteur ne les déduit pas une seconde fois.
- Pour l’agrégat, les produits restent bornés par la configuration de
  l’orchestrateur. Chaque produit utilise son mark capturé; indisponibilité
  d’un produit avec position ouverte rend indisponible la somme consolidée.

## Revue de risque et de persistance

`resolveDailyRiskWindow`, le `RiskSnapshot`, `checkRisk`, la garde
`RISK_PROPOSED`, les plafonds et transitions existants restent inchangés.
`accountEquity` public paper devient une mesure de reporting distincte de la
valeur historique transmise à l’interpréteur au rapprochement. Le champ
`otherExposureNotional` du stub paper devient absent en télémétrie; la nouvelle
mesure consolidée ne revient pas dans la machine d’admission.

Les marques vivent hors contexte XState, dans l’état normalisé du Durable
Object et du runtime produit multi-actifs. Un marqueur sans prix/source/date/
timeframe/limite cohérents est indisponible ou rejeté; une restauration legacy
normalise vers `null`. Les artefacts de cycle persistés gardent le mark capturé
pour que `/pnl` puisse reproduire la mesure sans dépendre de la configuration
courante.

## Vérifications avant implémentation

- [x] Formule et limites temporelles fermées dans `paper-valuation.ts`.
- [x] Modèle dailyRisk explicité comme hors changement; aucune entrée risque
      redirigée vers la nouvelle mesure.
- [x] Compatibilité additive API/AE décrite; positions Analytics Engine 1–7
      préservées.
- [x] Effets de frais/fill, valeur stale, absence, horloge future et flat cash
      couverts par tests de modèle.
- [x] Tests d'intégration runtime, restauration, portfolio API, dashboard,
      Analytics Engine et invariance des admissions — vérification 2026-09-26.

## Limites acceptées

Une mesure stale peut apparaître sous son ancien montant; son étiquette et son
âge doivent rester visibles. L’absence de mark interdit l’affichage d’une
exposition numérique pour une position ouverte. Le contrôle du risque continue
de refléter son contrat préexistant et n’est pas réputé amélioré par cette
évolution.

## Implémentation et vérification DAO #62 — 2026-09-26

- [x] Le `MarketSnapshot` capture le close, la clôture de bougie, le timeframe
      et la limite de fraîcheur; l'état mono-produit et chaque runtime produit
      restaurent le dernier mark hors contexte XState.
- [x] `/state`, `/pnl`, la projection multi-produits et le dashboard utilisent
      le projecteur commun; les réponses anciennes normalisent les marks en
      `unavailable` et ne gardent aucune équité reconstruite.
- [x] `schemaVersion=3` conserve blobs 1–7 et doubles 1–10; les trois blobs
      et huit doubles sont append-only avec qualité et bits de présence.
- [x] `checkRisk`, les plafonds d'admission, les gardes, les transitions et la
      formule de `dailyRisk` ne reçoivent aucune entrée nouvelle.
- [x] Vérification : models 430/430, agent 264/264, dashboard 45/45; TypeScript
      pour models/agent/dashboard et Biome lint sur les fichiers modifiés passent.
