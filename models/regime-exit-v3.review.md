# Review — bras hétérogènes par régime v3

Statut : APPROUVÉ AVEC CORRECTIONS (intégrées au modèle)
Date : 2025-12-17
Modèle : `regime-exit-v3.md`

## Checklist

### Cas nominaux
- [x] Bras bullish TRAILING : résolu par `resolveRegimeExitArm` en
      politique active, consommé par la machine existante (ratchet via
      `completeRange` → `advanceTrailingPlan`, en place depuis le cycle
      trailing v1).
- [x] Replan au flip de régime : chemin vérifié dans `replay.ts`
      L591-617 — égalité (`activeProtectivePolicyEquals`, couvre
      TRAILING depuis v2) → `CANCEL_REQUESTED` → re-arm si position
      ouverte. Zéro changement requis.
- [x] Sans `--bull-trail-bps` : structure V1 exacte (bullish NONE) —
      RC1.

### Erreurs
- [x] Bras TRAILING invalide (trailBps ≤ 0 ou ≥ 10 000) → rejet
      politique (RC2), bornes déléguées au validateur du mode pour
      rester à source unique.
- [x] CLI : `--bull-trail-bps` hors REGIME_CONDITIONAL → rejet ; sans
      stop+take → rejet par la branche existante (RC6, corrigé pour
      l'expliciter).

### Annulations / replans
- [x] armé→armé (FIXED↔TRAILING au flip) suit le même chemin que
      armé→NONE de V1 : cancel puis re-arm, anchor réinitialisé à
      l'entrée courante (RC5 = TE6, en place).
- [x] Aucun replan si les politiques sont égales (RC4).

### Permissions
- [x] Gate de régime inchangé (EMA_THRESHOLD 100/5/3) — les bras
      n'affectent que l'exit, pas le filtrage des signaux.

### Transitions implicites / texte libre
- [x] Les bras sont des données pures résolues par fonction pure ; zéro
      nouvelle transition (RC7). Aucun LLM.

### États terminaux
- [x] `triggered`/`cancelled`/`failed` inchangés ; le plan issue d'un
      bras TRAILING y termine identiquement (RC3).

## Corrections demandées (appliquées au modèle avant approbation)

1. **§2.2** : préciser l'assignabilité structurelle — la variante bras
   TRAILING (sans take) est assignable au mode (take optionnel) ; la
   signature de `resolveRegimeExitArm` ne change pas.
2. **§2.3** : la validation du bras doit **déléguer** à
   `isValidProtectiveExitPolicy` plutôt que dupliquer les bornes —
   source unique des constantes.
3. **RC6** : expliciter que le bras armé fixe (stop+take) reste requis
   en REGIME_CONDITIONAL — `--bull-trail-bps` seul est insuffisant.

## Risques résiduels assumés

- L'attribution n'est pas à variable unique au niveau trade (les flips
  intrfenêtre arment l'autre mécanisme) — couvert par le plan de
  mesure §4 (compteurs stops/takes, grille 500 vs 700).
- La barre bull +3 % n'est pas ajustée malgré un attendu +2,61 % :
  choix falsifiable assumé, décision explicite prévue au verdict.

## Verdict

APPROUVÉ. Changement purement additif côté modèles (une variante d'union
+ une branche de validation déléguée), CLI un flag optionnel avec
bit-identité V1 sans lui. Le risque d'implémentation principal
(interaction des flips intrfenêtre) est de nature mesure, pas code —
couvert par le plan de mesure.
