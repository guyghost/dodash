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
- Protocole A (§7.A, implémentation 2026-10-30) : les lignes portent une
  colonne `collection` (`SHADOW`/`RETROSPECTIVE`, migration additive) ; une
  ligne SHADOW n'est jamais réécrite ni réinterrogée — c'est l'échantillon
  prospectif propre (INV 12) — et une ligne RETROSPECTIVE n'est re-collectée
  que sur `force`. Le lot est borné à 48 bougies par appel ; un défaut
  LOOKAHEAD arrête net le lot ; chaque log de lot porte
  `RETROSPECTIVE_POSSIBLY_CONTAMINATED`. La fenêtre historique passe par le
  même service marché (`end` en secondes), sans ticker ni gate de fraîcheur
  live.
- Rapport de calibration (§8, implémentation 2026-10-30) :
  `computeTrendCalibration` est pure dans `models/` (ECE + 10 bins,
  INV 13) ; la jointure issue (`resolveTrendOutcomes`) vit dans la coquille,
  pure également ; issues non closes ou bougies absentes → `PENDING`,
  jamais comptées. La lecture passe par
  `GET /api/agents/:name/ai-trend-calibration` (fenêtre ≤ 288 bougies,
  horizon 1-24) ; le script `apps/agent/scripts/ai-trend-calibration.mjs`
  stratifie par collection et appose l'étiquette de contamination. Le
  vocabulaire FLAT (issue) et NEUTRAL (biais) est distinct : FLAT n'est
  correct que pour NEUTRAL (bug attrapé par les tests).

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

## Revue de l'amendement du 2026-10-30 — question v2 (§9)

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE** (opérateur, « on y va »),
motivé par le rapport ECE v1 (ECE 0.23-0.31, surconfiance ~94 % pour
50-60 % de précision).

- Composition pure dans `models/` (INV 17) : `composeTrendFromBatteryV2`
  (argmax de trois événements exclusifs, tie-break UP > DOWN > NEUTRAL) et
  `resolveVolScaledOutcome` (issue à seuil persisté, INV 16 ; θ = 0
  retrouve la règle v1, égalité stricte → FLAT — limite attrapée par les
  tests).
- Features calculées uniquement sur bougies closes ≤ C (INV 15), via
  `computeIndicators` du dépôt (zéro duplication d'indicateurs) ;
  `regime`/`readability` sont télémétrie pure, jamais dans le signal.
- Versionnement en base (`question_version`, `threshold_bps`, migrations
  additives) ; A/B v1+v2 sur paper via `AI_TREND_V2` ; rapport ECE
  stratifié par collection et version.
- Limites acceptées : la v2 se juge sur les mêmes gates (SHADOW, jamais de
  consommation) ; le collecteur rétrospectif v2 (features rejouables
  historiquement) est un travail ultérieur.
