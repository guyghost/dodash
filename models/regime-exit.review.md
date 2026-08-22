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
