# Revue — Sizing par calibration de confiance v1

Verdict : APPROUVÉ AVEC CORRECTIONS
Date : 2026-08-22 (corrigé en phase Verify, voir l'erratum ci-dessous)
Revue de : `models/confidence-sizing.md`

## Vérifications effectuées (contre le code réel)

1. **Localisation du modèle** — `calibrateConfidence` vit bien dans le
   package models (`models/confidence-calibration.ts` L97-126) : 4
   profils, exposants {1, ½, ⅓, ¼}, idempotence sur {0,1} confirmée
   (L119-121), monotone en c. ✔️
2. **Point d'application** — `withConfidenceCalibration`
   (`packages/backtest/src/confidence-calibrated-strategy.ts`) wrappe
   la stratégie : HOLD et erreurs traversent inchangés (L23), la
   confiance recalibrée remplace celle du signal (L32-35), en amont de
   l'allocation. CS1 exact. ✔️
3. **Plomberie suite/CLI** — `suite.ts` accepte
   `confidenceCalibration` optionnel (L41, validé L109-111, défaut
   IDENTITY L138) ; le résultat expose par scénario
   `diagnosticSamples.requestedNotionalByStrategy` (L60-73) : la notion
   médiane par stratégie est calculable depuis le scénario ensemble. ✔️
4. **Portes de sélection** — borne notional [100, 400]
   (L85-86), dd ≤ 10 % (L87), turnover ≤ 10 (L88), fees ≤ 1 %
   (L89) : CS4 reprend exactement `selectConfidenceCalibrationProfile`. ✔️
5. **CS2 bit-identité** — IDENTITY = c^1 ; la configuration de mesure
   V1 n'avait pas de flag calibration (défaut IDENTITY). Même chemin
   de code, identité arithmétique. ✔️

## Corrections appliquées au modèle

1. **§4 turnover/feeRate** — « si exposés » était vague : le doc
   précise maintenant que turnover et feeRate sont dérivés des
   métriques du scénario ensemble si disponibles, sinon estimés depuis
   les diagnostics (fees cumulées / capital). Clarifié dans §4.
2. **§4 fenêtre CS4** — la porte notion médiane s'applique **par
   fenêtre ET par stratégie calibrée** (ima-cross, breakout) comme dans
   `selectConfidenceCalibrationProfile` (observations par runKey ×
   stratégie) : précisé.

## Risques acceptés

- Monotonie CS3 : les caps d'allocation (`maxDecisionNotional` 2000)
  peuvent aplatir HALF/THIRD/QUARTER au même plateau — la vérification
  porte alors sur l'égalité d'exposition, pas l'ordre strict. Le modèle
  dit bien « vérifiable », pas « strict ».
- Corrélation gate×calibration : le gate EMA_THRESHOLD filtre en
  RANGE ; les signaux émis en RANGE restent émis-puis-guettés, la
  calibration ne change pas cette interaction (confiance recalibrée
  avant le gate → taille only). OK.

## Checklist

- [x] États/transitions : aucun nouveau (pur)
- [x] Effets de bord : aucun hors mesure
- [x] Cas limites : c=0, c=1, HOLD, erreurs — déjà couverts par les tests models
- [x] Critères a priori définis avant mesure
- [x] Aucune transition pilotée par texte libre / LLM

## Erratum (phase Verify, 2026-08-22)

La revue ci-dessus a été menée alors que la configuration de mesure
était encore erronée sur deux points, découverts en Verify :

1. **Bras V1** — la première grille utilisait bear/range/warmUp FIXED
   **600/600** (bras de v3 indûment hérité). La baseline V1 n'était
   pas reproductible (+3,63 % → −1,67 % en bull IDENTITY). Après
   recoupement avec le checkpoint 006 (V1 mesuré via CLI
   `--stop-loss-bps 300 --take-profit-bps 600`), correction en
   **300/600** : la baseline est alors reproduite bit pour bit. La
   vérification CS5-like « la mesure doit reproduire le champion avant
   de mesurer la variation » mérite d'être un critère systématique des
   campagnes de mesure.
2. **Dates** — le doc initial datait la campagne du 2025-12-17 ;
   les fenêtres réelles s'achèvent en 2026 (bear jusqu'au 2026-08-21).
   Dates corrigées.

Aucune des vérifications code (§ Vérifications) n'est affectée :
elles portent sur `confidence-calibration.ts`,
`confidence-calibrated-strategy.ts` et `suite.ts`, inchangés.
