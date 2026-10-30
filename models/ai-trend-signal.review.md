# Revue — signal de tendance IA, modulation bornée (2026-10-30)

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**.

Approuvé par l'opérateur (2026-10-30, décision d'utiliser Jev pour une
tendance d'achat consommée par le trading) après amendement fondateur
explicite de `decision-core.md` INV 5 et note datée `README.md` INV 8-9.

- Le signal **module** la confiance des signaux des stratégies
  déterministes dans `[1, maxFactor]`, strictement positif : aucune
  inversion de direction possible, aucune origination, aucune transition —
  `decision-core.md` INV 1-4 intacts, INV 5 amendé en connaissance de
  cause.
- INV 8 du `README.md` préservé : le backtest replay des signaux
  enregistrés via exactement les mêmes fonctions pures ; protocole A
  (rétrospectif, étiqueté `RETROSPECTIVE_POSSIBLY_CONTAMINATED`) et
  protocole B (prospectif SHADOW) définis, `PAPER` jugé sur B seul
  (INV 12).
- Gates : SHADOW → PAPER après calibration acceptée ; LIVE interdit sans
  nouvel amendement.
- Limites acceptées : le saut gateway ajoute de la latence (bornée par
  `maxAgeMs`) ; le schéma des questions Jev via gateway reste à confirmer
  au premier appel authentifié.

## Notes d'implémentation acceptées (interprétations de la spec)

- Fenêtre de fraîcheur : §2 disait « `now − observedAt > maxAgeMs` » et
  §7 « `observedAt ≤ instant < observedAt + maxAgeMs` » ; la borne
  **stricte** de §7 est retenue (fenêtre `[observedAt, observedAt +
  maxAgeMs[`), un signal non encore observé (`now < observedAt`) est
  `STALE`.
- `evaluateTrendSignal` borne le facteur dans `[1, maxFactor]` sans
  condition : même une probabilité mal formée hors `[0, 1]` ne peut pas
  produire une modulation hors plage (INV 1 inconditionnel).
- `validateTrendPolicy` ajouté (INV 7 : `maxFactor ∈ ]1, 2]`,
  `minProbability ∈ ]0.5, 1[`, `maxAgeMs` entier sûr positif).
- `applyTrendModulation` utilise l'interface structurelle `ModulableSignal`
  (productId, side, confidence) : `models/` ne dépend pas de
  `@dodash/domain`, dont le type `Signal` lui est structurellement
  assignable ; les autres champs sont préservés (générique `T`).
- Plafond de confiance : produit borné à 1 après modulation (§6).
- `dedupeTrendSignals` : la plus récente `observedAt` gagne par
  `(productId, candleClosedAt)` ; égalité résolue par l'ordre du tableau.
- `buildRetrospectiveTrendState` (§7.A) : toute bougie de clôture
  postérieure à `C` est un défaut bloquant `LOOKAHEAD` (jamais filtrée
  silencieusement) ; état produit = `{ json: { candles } }` trié.
- L'adaptateur gateway et le producteur SHADOW vivent dans la coquille
  (`apps/agent`) : hors périmètre de ce module, étape suivante distincte.

## Vérification requise (§6, §7) → couverture de tests

| Item spec | Tests |
|---|---|
| Quatre raisons `INACTIVE` (DISABLED, STALE, NEUTRAL, BELOW_THRESHOLD) | `evaluateTrendSignal rejects each inactivity reason` |
| Seuil exact : `probability = minProbability` → `factor = 1` ; `probability = 1` → `maxFactor` | `evaluateTrendSignal maps thresholds exactly` |
| `factor ∈ [1, maxFactor]` sur toute la plage `[0, 1]`, `> 0` (propriété) | `evaluateTrendSignal bounds the factor over the whole probability range` |
| Confiance alignée × `factor`, opposée et `HOLD` inchangés, plafond 1 | `applyTrendModulation ...` |
| Déduplication `(productId, candleClosedAt)` : la plus récente gagne | `dedupeTrendSignals keeps the most recent signal per candle` |
| INV 11 : `observedAt ≤ instant < observedAt + maxAgeMs` | `evaluateTrendSignal enforces the availability window` |
| INV 10 : donnée postérieure à `C` rejetée (défaut bloquant) | `buildRetrospectiveTrendState ...` |
| Aucun réseau dans `models/` | `performs no network access from models/` |
| INV 7 : politique figée valide | `validateTrendPolicy ...` |
