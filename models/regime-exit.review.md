# Review du modèle REGIME_CONDITIONAL (regime-exit.md)

Review avant implémentation, contre le checklist exigé : cas nominaux,
erreurs, annulations, retries, permissions, états terminaux, transitions
implicites.

## Checklist

### Cas nominaux

- **Position ouverte en BULLISH (bras NONE)** : aucun plan armé, position
  suit la tendance — conforme au scénario mesuré (+7,42 %).
- **Transition confirmée BULLISH→BEARISH avec position ouverte** : armement
  au point de replan, stop/take calculés depuis l'avg entry courante
  (RE4), effectif bougie N+1. ✔
- **BEARISH→RANGE à bras identiques** : aucun replan (RE3) — les niveaux
  du plan en cours sont préservés, pas de reset intempestif. ✔
- **Position fermée par trigger à N, régime change aussi à N** : le
  trigger s'exécute d'abord (étape 1), l'acteur est déjà annulé et
  remplacé par null au point de replan — cas explicitement couvert. ✔

### Erreurs

- Politique invalide (bornes bps) → `INVALID_PROTECTIVE_POLICY` à la
  validation, avant toute bougie. ✔
- `REGIME_CONDITIONAL` sans `regimeFilter` → `INVALID_BACKTEST_CONFIG`
  (RE7) + erreur CLI avant exécution. ✔
- Échec d'armement au replan → `PROTECTIVE_ORDER_FAILURE` terminal,
  hérité de la mécanique existante. ✔

### Annulations

- `POSITION_CLOSED` (fill de sortie stratégie) : inchangé.
- `STRATEGY_EXIT` : inchangé.
- `REGIME_CHANGED` : nouveau, désarme sans vendre — la position reste
  ouverte, seul le plan protectif est remplacé/désarmé. Sémantique
  distincte et explicite. ✔

### Retries

- Aucun retry dans le modèle protective (échec = terminal) — inchangé et
  assumé. Le replan n'est **pas** un retry : c'est une transition de
  politique, jamais une re-exécution d'ordre. ✔

### Permissions

- Orthogonal au regime gating : le gating filtre les *entrées* (signaux),
  REGIME_CONDITIONAL gouverne les *sorties protectives*. Composition sans
  interaction : chaque machine ne consomme que ses propres événements. ✔

### États terminaux

- `protective-order` : triggered→executed, cancelled, failed — inchangés.
- `regime-filter` : stopped/failed — inchangés ; un failed régime fait
  échouer le replay avant le point de replan (check existant). ✔

### Transitions implicites

- Une seule : le point de replan, déclenché exclusivement par un changement
  de `context.regime` **confirmé** de la machine régime (jamais par une
  brute non confirmée — la streak doit être satisfaite d'abord). À
  expliciter dans le modèle (voir V2).

## Verdicts sur les invariants

- **RE1–RE4, RE6–RE9** : validés, testables unitairement.
- **RE5 : AMBIGU — à corriger avant implémentation.** Tel que rédigé
  (« aucun plan n'est appliqué rétroactivement à la bougie de sa
  création »), il contredit la sémantique existante de l'armement sur
  fill : aujourd'hui, un plan armé après exécution EST évalué contre le
  range de la bougie d'armement (range rejoué, conservateur). RE5 n'est
  vrai que pour le replan (créé après le range replay de N). Reformuler
  pour distinguer les deux chemins d'armement.

## Corrections exigées (V2 du modèle)

1. **RE5 reformulé** : le replan (étape 4) crée un plan non évalué contre
   la bougie N (open et range), effectif N+1 ; l'armement sur fill
   conserve la sémantique v1 (range de la bougie d'armement rejoué).
2. **Préciser « transition confirmée »** : le point de replan lit
   `context.regime` de la machine régime, qui ne change qu'après
   satisfaction de `confirmationCount` — une brute isolée ne déclenche
   jamais de replan.

## Décision

**GO pour implémentation** après application des corrections V2. Le
modèle couvre le checklist ; aucune transition pilotée par texte libre ;
le LLM n'apparaît à aucun niveau (RE1). Aucune impasse d'état : le point
de replan est total sur (plan armé ?, arm(N) null ?, changement
effectif ?).

## Vérification (Verify) — mesures du 2026 (runs BTC-USD ONE_DAY, regime EMA_THRESHOLD 100/5/3)

Politique mesurée : `REGIME_CONDITIONAL` bullish=NONE, bearish/range/warmUp=FIXED 300/600.

| Configuration | Bull 2023-08-21→2024-08-21 | Bear 2025-08-21→2026-08-21 |
| --- | --- | --- |
| no-protective + gating (réf.) | +7.42% | −15.13% (dd 30.3%) |
| FIXED 300/600 + gating (réf.) | −0.38% | +3.70% (dd 3.3%) |
| **REGIME_CONDITIONAL v1** | **+0.27%** (dd 2.93%, 5 stops) | **+3.63%** (dd 3.37%, 23 stops) |

Lecture :

- **Bear : objectif atteint.** +3.63% vs +3.70% en fixed, drawdown
  équivalent (3.37% vs 3.3%) — le bras BEARISH/RANGE armé préserve
  intégralement la protection qui justifiait les exits (vs −15.13%
  sans protection).
- **Bull : amélioration directionnelle mais potentielle non recouvré.**
  +0.27% vs −0.38% en fixed (les stops tombent de 11 à 5), mais loin
  du +7.42% non protégé. Cause mesurée : en année bull, le régime
  passe l'essentiel du temps classé BEARISH/RANGE (final=BEARISH,
  seulement 199/339 observations avec un régime BULLISH confirmé) ; les
  positions rsi-reversion ouvertes hors BULLISH restent donc stoppées
  à −3% exactement comme en fixed. Le bras BULLISH=NONE ne bénéficie
  qu'aux entrées ema-cross/breakout (ema-cross : 0 trade, confiance
  trop faible ; breakout : 21 trades, 0 stop).

Conclusion : l'hypothèse « la destruction de valeur bull vient des
stops sur les positions ouvertes pendant BULLISH » est **invalidée** ;
la destruction vient des stops sur positions rsi-reversion ouvertes en
RANGE/BEARISH sur un marché montant. Pistes V2 (à modéliser puis
mesurer séparément) : bras RANGE=NONE, ou stop asymétrique élargi hors
BULLISH.

Invariants vérifiés par l'implémentation : RE7 (2 tests replay+CLI),
RE3/RE4/RE5 (tests replay), RE9 (suites protective/regime-gating
inchangées, 73/73 verts), machine protective-order sans modification
(cancel REGIME_CHANGED passé génériquement).
