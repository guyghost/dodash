# Review — exit trailing TRAILING_BPS

Statut : APPROUVÉ AVEC CORRECTIONS
Date : 2025-12-17
Modèle revu : `trailing-exit.md`

## Checklist

### Cas nominaux
- [x] Armement sur fill : plan initial stop = entrée×(1−trail), anchor =
  entrée ; la bougie d'armement est évaluée (open puis range) avec ce
  niveau, son high alimente l'anchor **après** évaluation (parité
  arm-on-fill RE5).
- [x] Bougie suivante : gap-open évalué contre stop_t (anchor de t−1
  intégré), puis intrabar, puis ratchet anchor_t = max(anchor_{t−1},
  high_t).
- [x] Bougie sans déclenchement : `completeRange` → plan remplacé via
  `advanceTrailingPlan` (pure), retour `awaitingOpen`.
- [x] POSITION_REDUCED : quantité seule, anchor/stop inchangés
  (`reducePlan` intact).
- [x] POSITION_INCREASED : replan depuis le nouveau prix moyen, anchor
  réinitialisé (parité RE4 ; TE1 s'applique par instance de plan).
- [x] Régime : en mode TRAILING_BPS le bloc de replan
  REGIME_CONDITIONAL est ignoré ; le régime ne fait que gater les
  entrées (permissions inchangées).

### Erreurs
- [x] `trailBps` invalide (≤ 0, ≥ 10 000, non fini) →
  `isValidProtectiveExitPolicy` faux → machine `failed` /
  `INVALID_PROTECTIVE_PLAN` (codes existants, TE8).
- [x] CLI non numérique → rejet au parse (chemin des flags numériques).
- [x] Plan TRAILING avec takeBps : impossible par construction (union
  discriminée par mode ; le variant TRAILING_BPS n'expose pas takeBps).

### Annulations / retries
- [x] CANCEL_REQUESTED (POSITION_CLOSED, STRATEGY_EXIT) → `cancelled`
  inchangé ; pas de retry (final states inchangés).

### Permissions
- [x] Aucune permission touchée : DEFAULT_REGIME_PERMISSIONS et le
  gating d'entrée sont hors périmètre.

### États terminaux
- [x] `triggered` / `cancelled` / `failed` inchangés ; TRAILING sort
  par `triggered` (STOP_LOSS GAP_OPEN ou INTRABAR, TE4).

### Transitions implicites / texte libre / LLM
- [x] Aucune nouvelle transition structurelle : le ratchet est une
  action d'assign sur transition existante (`completeRange`), calculée
  par fonction pure. Aucun texte libre, aucun LLM (TE9).

## Corrections exigées avant implémentation

1. **TE1 — portée par instance** : la monotonie du stop vaut par
   instance de plan ; POSITION_INCREASED démarre une nouvelle instance
   (anchor réinitialisé, le stop peut redescendre mécaniquement).
   *Application : invariant reformulé dans `trailing-exit.md`.*
2. **TE5 — migration `takeProfitPrice: number | null`** : chaque
   comparaison existante (open/high/low vs TP) doit porter le guard
   `!== null` ; les tests FIXED_BPS / REGIME_CONDITIONAL doivent geler
   le comportement TP bit-identique. *Application : précisé au §2.2 du
   modèle.*
3. **Diagnostics sans changement de schéma** : les exits trailing sont
   des STOP_LOSS ordinaires ; l'étude distingue « exit en gain verrouillé
   » (prix de sortie > prix moyen d'entrée) **a posteriori** depuis les
   records de trades — aucun champ de métriques ajouté.

## Vérifications d'implémentation attendues (transmises à Verify)

- Test unitaire TE1/TE2 : stop ne monte qu'après range complète ; une
  bougie dont le low touche stop_t et le high ferait monter l'anchor →
  sortie INTRABAR au niveau figé (pas de ratchet intra-bougie).
- Test unitaire TE3 : anchor = max(entrée, highs des bougies évaluées) ;
  arm candle inclus.
- Test unitaire TE5 : plans FIXED_BPS identiques avant/après migration
  (stop, TP, quantités, résolutions open/range).
- Tests TE7 : CLI TRAILING sans `--trail-bps` rejeté ; `--trail-bps`
  sans TRAILING rejeté ; manifeste/suffixe `-trailing-{bps}`.
- Grille 150/300/500 × fenêtres bull/bear, verdict contre critères a
  priori, comparé aux baselines V1 (bull +0,27 %, bear +3,63 %).

## Verdict

Surface minimale (un mode d'union, un champ nullable, une action pure
de ratchet, deux flags CLI), invariants de compatibilité explicites
(TE5 bit-identité), ordre anti look-ahead défini sans ambiguïté, plan
de mesure falsifiable avec diagnostic d'échec. **Approuvé avec les 3
corrections ci-dessus (appliquées au document modèle).**
