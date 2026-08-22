# Étude V2 — Bras RANGE des sorties protectives régime-conditionnelles

Statut : **en cours de mesure**. Étude de sensibilité ad hoc (même nature que
`bull-alpha-diagnosis`) : le script ne modifie aucun workflow, aucune machine
d'état, aucune décision d'état. **Aucun changement au modèle `regime-exit`** :
`RegimeConditionalExitPolicy` exprime déjà chaque bras comme
`NONE | FIXED_BPS` indépendant ; les variantes mesurées ici sont des valeurs
légitimes du modèle existant, validées par `isValidRegimeConditionalExitPolicy`.

## Motivation (mesurée, cf. `regime-exit.review.md` — Verify V1)

| Configuration | Bull 2023-08-21→2024-08-21 | Bear 2025-08-21→2026-08-21 |
| --- | --- | --- |
| no-protective + gating | +7.42% | −15.13% (dd 30.3%) |
| FIXED 300/600 + gating | −0.38% | +3.70% (dd 3.3%) |
| REGIME_CONDITIONAL v1 (bull=NONE, autres 300/600) | +0.27% | +3.63% (dd 3.37%) |

Hypothèse V1 invalidée : la destruction de valeur bull ne vient pas des stops
sur positions BULLISH mais des stops sur positions **rsi-reversion ouvertes en
RANGE/BEARISH** pendant un marché montant — le régime passe l'essentiel de
l'année bull classé RANGE/BEARISH (final=BEARISH).

## Hypothèses V2 (falsifiables, a priori)

- **H1** : `range=NONE` supprime la majorité des 5 stops bull restants et
  rapproche le retour bull du potentiel non protégé (+7.42%).
- **H2** : `range=NONE` dégrade le bear (l'année bear finit classée RANGE) mais
  le bear reste protégé tant que `bearish` reste armé — dégradation bornée.
- **H3** : un stop RANGE asymétrique élargi (`range=600/1200`) capture une
  partie du gain bull de H1 avec moins de dégradation bear que `range=NONE`.

## Grille mesurée

Contraintes communes : `bullish=NONE` (v1), `warmUp` lié au bras `bearish`
(sémantique v1), gating `EMA_THRESHOLD 100/5/3`, notional 1000, IDENTITY,
frais 6 bps + slippage 2 bps, capital 10 000.

| Cellule | range | bearish | note |
| --- | --- | --- | --- |
| A1 | FIXED 300/600 | FIXED 300/600 | = V1 (re-productibilité) |
| A2 | FIXED 300/600 | FIXED 600/1200 | élargit BEARISH |
| B1 | NONE | FIXED 300/600 | H1/H2 |
| B2 | NONE | FIXED 600/1200 | H1 + BEARISH élargi |
| C1 | FIXED 600/1200 | FIXED 300/600 | H3 |
| C2 | FIXED 600/1200 | FIXED 600/1200 | H3 + BEARISH élargi |

Fenêtres fixes (celles des artefacts de référence) : bull
2023-08-21→2024-08-21, bear 2025-08-21→2026-08-21. Métriques par cellule×
fenêtre : `totalReturn`, `maxDrawdown`, `stopLossExitCount`,
`takeProfitExitCount` du scénario `ensemble`.

## Critères de décision (fixés a priori, avant mesure)

Une cellule est **retenue** ssi :

1. Bull : `totalReturn ≥ +3%` (récupérer ~40 % de l'écart V1→no-protective).
2. Bear : `totalReturn > 0` **et** `maxDrawdown ≤ 10%`.

Parmi les cellules retenues : maximiser le retour bull, départager à
`maxDrawdown` bear minimal. Si aucune cellule ne passe : **H1–H3 invalidées**,
pas de changement CLI, conclusion documentée ci-dessous.

Le verdict ne déclenche **aucune transition d'état** : il oriente au mieux une
proposition d'extension CLI (cycle Model→Review→Implement→Verify séparé).

## Review (checklist de l'étude)

- Baselines incluses : A1 re-produit V1 (contrôle de non-régression de la
  mesure) ; références citées depuis les artefacts committés.
- Fenêtres et config figées avant mesure ; critères fixés a priori.
- Aucune modification de `regime-exit` (modèle, machine, replay) ; le script
  consomme uniquement `runBacktestSuite`.
- Aucun LLM, aucune entrée texte libre ; décisions = comparaisons numériques
  sur critères ci-dessus.
- Étude mono-actif (BTC-USD ONE_DAY) : conclusion bornée à ce périmètre,
  généralisation interdite sans mesure supplémentaire.

## Mesures (Verify)

_Tableau à compléter par `npx tsx scripts/regime-exit-sensitivity.ts`._

## Verdict

_À compléter après mesure._
