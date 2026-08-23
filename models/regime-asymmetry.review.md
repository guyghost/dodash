# Review — seuil BEARISH asymétrique (v3)

Statut : APPROUVÉ AVEC CORRECTIONS
Date : 2025-12-17
Modèle revu : `regime-asymmetry.md`

## Checklist

### Cas nominaux
- [x] `bearishThresholdBps` absent → politique v1, classification identique (RA1).
- [x] Présent → BEARISH exige `gap < −bearishThresholdBps` ; BULLISH/RANGE inchangés (RA3).
- [x] Warm-up, streaks de confirmation, transitions de régime : machine non modifiée, l'asymétrie n'entre que dans `classifyRegimeObservation` (pure).
- [x] Interaction avec `REGIME_CONDITIONAL` : le re-labeling creux→RANGE change le bras d'exit hérité (effet recherché) sans toucher aux replans (RE3-RE5 inchangés).

### Erreurs
- [x] `bearishThresholdBps` invalide (≤ 0, ≥ 10000, non fini) → `isValidRegimeFilterPolicy` faux → machine `failed` / `INVALID_REGIME_POLICY` (RA2, identique v1).
- [x] CLI : valeur non numérique → rejet parse (chemin identique aux autres flags numériques).

### Annulations / retries
- [x] Sans objet : classification sans état, machine inchangée (`STOP_REQUESTED` → `stopped` inchangé).

### Permissions
- [x] `DEFAULT_REGIME_PERMISSIONS` inchangé ; BEARISH et RANGE autorisent tous deux rsi-reversion, donc le re-labeling ne (dés)autoris aucune stratégie (RA4).

### États terminaux
- [x] `stopped` / `failed` inchangés.

### Transitions implicites / texte libre / LLM
- [x] Aucune transition implicite ajoutée ; aucune entrée texte libre ; aucun LLM (RA6).

## Corrections exigées avant implémentation

1. **RA7 (nouveau) — garde CLI par mode** : `--regime-bearish-threshold-bps`
   doit être rejeté si `--regime-filter` est `NONE` ou `EMA_SLOPE`
   (champ spécifique au mode, miroir de la règle R6 existante : les flags
   `--regime-slope-*` sont rejetés en mode EMA_THRESHOLD).
2. **RA1 — sémantique flottante** : la branche EMA_THRESHOLD ne doit PAS
   introduire d'epsilon (contrairement à EMA_SLOPE) ; conserver les
   inégalités strictes v1 pour garantir la bit-identité quand le champ est
   absent.
3. **Ordre relatif non contraint** : RA2 ne contraint pas
   `bearishThresholdBps` relativement à `thresholdBps` (l'asymétrie
   inversée — seuil bear plus bas — reste une politique valide à mesurer).
   Le document modèle est explicite sur ce point.

## Vérifications d'implémentation attendues (transmises à Verify)

- Test unitaire RA1 : classification bit-identique v1 sur séquence de
  référence avec et sans `bearishThresholdBps` absent.
- Test unitaire RA3 : gap modérément négatif (ex. −150 bps) classé RANGE
  avec bear=200, BEARISH avec bear=100 ; gap +N bps inchangé.
- Test RA7 : rejet CLI en modes NONE et EMA_SLOPE.
- Test RA5 : runId/suffixe inchangés sans flag ; étendus avec flag.
- Grille D1-F3 sur les deux fenêtres, verdict contre critères a priori.

## Verdict

Le modèle couvre le changement avec une surface minimale (un champ
optionnel + une branche de classification + un flag CLI), des invariants
de compatibilité explicites et un plan de mesure falsifiable
(mécanisme invalide si D2/D3 ≈ D1 sur le bull). **Approuvé avec les 3
corrections ci-dessus.**
