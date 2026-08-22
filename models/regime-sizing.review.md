# Review — regime-sizing.md

Date : 2026-08-23 · Reviewer : agent (vérification contre le code) ·
Verdict : **APPROUVÉ** (2 corrections appliquées pendant la review)

## Vérifications contre le code

| #  | Claim du modèle                                      | Preuve code                                                                 | Verdict |
|----|------------------------------------------------------|------------------------------------------------------------------------------|---------|
| R1 | Point d'application : après gate, avant allocation   | `replay.ts` L647 `resolveRegimePermission` → L655 `gatedSignals = allowedSignals` → L658 `allocateSignals({` ; aucune mutation entre L655 et L658 | ✔ exact |
| R2 | Régime résolu par candle avant le filtrage            | `replay.ts` L600 `regimeActor.send(CANDLE_CLOSED)` → L610 snapshot → L614 `activeRegime = regimeSnapshot.context.regime` (`RegimeKind \| null`) | ✔ |
| R3 | `calibrateConfidence` pur, transparent sur {0,1}      | `confidence-calibration.ts` L97-126 : c ∈ {0,1} pass-through, sinon c^k ; sans effet de bord | ✔ INV-S1 fondé |
| R4 | La confiance recalibrée est effectivement consommée   | `allocator.ts` L84-89 : `net = Σ side × suggestedSize × confidence` ; `target-notional-strategy.ts` L16-19 : `suggestedSize = target/price` (indépendant de la confiance) | ✔ |
| R5 | Pattern à bras miroir existant                        | `protective-order.ts` L92-105 `resolveRegimeExitArm` : null→warmUp, BULLISH→bullish, BEARISH→bearish, sinon range | ✔ |
| R6 | Fenêtres D12 reproductibles                           | script D12 `windowBounds` L30-36 : `[YYYY-08-21 → (YYYY+1)-08-21]` UTC, rejet si non aligné | ✔ |
| R7 | Restriction aux stratégies calibrables est aujourd'hui privée | `confidence-calibration.ts` L74 `const CALIBRATED_STRATEGY_IDS = Object.freeze([..])` — non exporté ; §5 du modèle prévoit l'export | ✔ action requise |
| R8 | INV-S2 : deux couches de calibration impossibles       | suite.ts L109-110 valide déjà `confidenceCalibration` ; le pattern de validation config existe des deux côtés (suite + replay L167-169) — à étendre, aucun mécanisme implicite prévu | ✔ |

## Corrections demandées et appliquées

1. **Court-circuit IDENTITY (§3)** — le modèle original recalibrait même le
   bras IDENTITY (recréation de signal). Pour que INV-S1 soit bit-exact
   **par construction** (indépendant de toute fonction de recréation),
   le bras IDENTITY ne touche aucun signal. Appliqué au modèle.
2. **Bornes de fenêtres (§6)** — « 2016→2026 » ambigu ; précisé :
   étiquettes 2016..2025, bornes `[YYYY-08-21 → YYYY+1-08-21]` UTC
   (miroir `windowBounds` D12). Appliqué.

## Analyse des invariants

- **INV-S1** : fondé sur R3 + court-circuit. Vérifiable par campagne
  WF2-S (bit-identité des baselines).
- **INV-S2** : validé aux deux couches (suite + replay). Aucun chemin
  où deux calibrations coexistent.
- **INV-S3** : le résolveur est une table exhaustive sur
  `RegimeKind ∪ {null}` — total par construction, test unitaire
  trivial à écrire.
- **INV-S4** : miroir du wrapper statique (HOLD pass-through L23,
  non-calibrés exclus). Test unitaire : signal rsi-reversion inchangé,
  HOLD inchangé, signal ema-cross recalibré.
- **INV-S5** : le replay ne contiendra aucune constante d'exposant ;
  grep de garde possible (`POWER_` interdit hors models/).

## Risques résiduels acceptés

- Sélection d'hypothèse structurelle post-lecture D12 — documentée
  §8 du modèle, non éliminable par construction.
- Le recalibrage s'applique aux signaux **autorisisés seulement** :
  différence comportementale vs wrapper statique (qui calibrait avant
  le gate). Sans effet sur les métriques (signaux déniés droppés),
  documenté ici pour traçabilité.

## Verdict

**APPROUVÉ** — le modèle est complet, falsifiable, ses invariants sont
fondés sur le code cité. Passage à l'implémentation autorisé.
