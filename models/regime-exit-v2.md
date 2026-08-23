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

`npx tsx scripts/regime-exit-sensitivity.ts` — ensemble, fenêtres fixes :

### Bull 2023-08-21→2024-08-21

| Cellule | range | bearish | return | dd | win | trades | stops | takes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 (=V1) | 300/600 | 300/600 | +0.27% | 2.93% | 44% | 50 | 5 | 4 |
| A2 | 300/600 | 600/1200 | −0.12% | 4.78% | 56% | 50 | 4 | 5 |
| B1 | NONE | 300/600 | +0.63% | 3.16% | 43% | 48 | 4 | 3 |
| **B2** | NONE | 600/1200 | **+4.30%** | 5.75% | **70%** | 51 | 3 | 3 |
| C1 | 600/1200 | 300/600 | +0.10% | 3.10% | 44% | 50 | 5 | 4 |
| C2 | 600/1200 | 600/1200 | +0.09% | 5.10% | 58% | 53 | 5 | 4 |

### Bear 2025-08-21→2026-08-21

| Cellule | range | bearish | return | dd | win | trades | stops | takes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 (=V1) | 300/600 | 300/600 | +3.63% | 3.37% | 26% | 89 | 23 | 8 |
| A2 | 300/600 | 600/1200 | −7.46% | 10.70% | 25% | 78 | 15 | 5 |
| B1 | NONE | 300/600 | +2.90% | 4.25% | 26% | 85 | 20 | 6 |
| B2 | NONE | 600/1200 | **−12.53%** | **14.19%** | 37% | 74 | 12 | 1 |
| **C1** | 600/1200 | 300/600 | **+4.07%** | 3.84% | 29% | 89 | 22 | 8 |
| C2 | 600/1200 | 600/1200 | −5.33% | 9.89% | 39% | 81 | 14 | 5 |

Contrôle : A1 re-produit V1 bit-à-bit (artefacts `regime-exit-300-600-regime-100-5-3`).

## Verdict

**Aucune cellule ne satisfait les critères a priori** (bull ≥ +3% ET bear > 0%
ET dd bear ≤ 10%). Application des critères :

- H1 invalidée : `range=NONE` ne retire qu'un stop bull sur cinq (B1 : +0.63%
  vs +0.27%) — les stops destructeurs de valeur bull ne sont pas dans le bras
  RANGE.
- H2 confirmée : la dégradation bear de `range=NONE` est bornée et faible
  (B1 : +2.90% vs +3.63%).
- H3 invalidée côté bull : `range=600/1200` ne récupère rien (C1 : +0.10%) ;
  en revanche C1 est le **meilleur bear mesuré** (+4.07%, dd 3.84%).

Conclusions structurelles :

1. **Le levier bull est le bras BEARISH, pas RANGE** : seul `bearish=600/1200`
   récupère le potentiel bull (B2 : +4.30%, win 70%) — le classifieur
   EMA_THRESHOLD étiquette BEARISH les creux d'une année haussière, et ce sont
   exactement les entrées rsi-reversion stoppées qui auraient survécu au
   rebond.
2. **Ce levier est le même que celui qui protège le bear** : le stop BEARISH
   serré qui détruit la valeur bull est celui qui sauve l'année bear (B2 :
   −12.53%, dd 14.19%). Une politique statique de bras par régime ne peut pas
   simultanément récupérer le bull et protéger le bear sur ce classifieur.
3. Sensibilité bear au stop RANGE élargi : négative (A2/C2 < 0) — l'année bear
   finit classée RANGE ; élargir RANGE déprotège la phase finale.

Décision : **pas de changement CLI** (aucune politique retenue). V1
(`bull=NONE`, autres 300/600) reste la configuration déployée ; C1
(`range=600/1200`) est le seul candidat « orienté bear » si l'appétit de risque
bull est déjà couvert par ailleurs.

Pistes suivantes (hors périmètre de cette étude, à modéliser séparément si
poursuivies) : améliorer la classification (creux bull vs tendance bear — par
exemple seuil asymétrique ou régime à hystérésis), ou mécanisme de sortie
différent (stop suiveur, sortie temporelle) qui ne soit pas un bracket fixe
par régime.

