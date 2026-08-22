# Review — trailing + take-profit combiné (TRAILING_BPS v2)

Statut : APPROUVÉ AVEC CORRECTIONS (intégrées au modèle)
Date : 2025-12-17
Modèle : `trailing-take-profit.md`

## Checklist

### Cas nominaux
- [x] TP présent : plan armé avec plafond `entrée × (1 + take/10 000)`,
      exit TAKE_PROFIT intrabar ou au gap d'open — séquence d'évaluation
      inchangée (vérifié dans `protective-order.ts` L236/L256-273).
- [x] TP absent : bit-identité v1 (TT1) — verrouillée par tests sur le
      plan `takeProfitPrice: null` et par la grille T1–T3 déjà consignée.
- [x] Ratchet inchangé jusqu'au premier exit (TT3) ; plan terminal après
      TAKE_PROFIT — état `triggered` existant, aucun nouvel état.

### Erreurs
- [x] `takeProfitBps` hors bornes → rejet politique (TT2, corrigé pour
      valider au niveau politique comme FIXED, pas seulement au plan).
- [x] `takeProfitPrice ≤ entrée` (débordement numérique) →
      `INVALID_PROTECTIVE_PLAN`.
- [x] CLI : `--take-profit-bps` hors contexte accepté → rejet (TT6).

### Ambiguïtés et conservatisme
- [x] Stop+TP touchés dans la même bougie → `AMBIGUOUS_STOP_FIRST`
      (TT4) — sémantique FIXED existante, `takeHit` est structurellement
      faux quand `takeProfitPrice` est null : sans le flag, aucune
      ambiguïté nouvelle possible.
- [x] Gap TP au open géré avant l'évaluation du range (ordre
      évalue-puis-ratchet préservé, TE de v1).

### Annulations / replans / permissions
- [x] Aucun nouvel événement ni transition : cancel/fail inchangés.
- [x] Mode uniforme → pas de replan protectif en replay (bloc
      REGIME_CONDITIONAL uniquement) ; l'extension d'égalité TT5 reste
      néanmoins requise pour cohérence de l'API.

### Transitions implicites / texte libre
- [x] Aucune décision pilotée par texte libre ; TP et trail restent des
      fonctions pures consommées par la machine (TT7). Aucun LLM.

### États terminaux
- [x] TAKE_PROFIT, STOP_LOSS → `triggered` (terminal existant) ;
      `cancelled`/`failed` inchangés.

## Corrections demandées (appliquées au modèle avant approbation)

1. **TT2** : la validation des bornes de `takeProfitBps` doit se faire
   au niveau politique (`INVALID_PROTECTIVE_POLICY`), comme FIXED — le
   modèle citait seulement le rejet au niveau plan.
2. **TT5** : préciser la sémantique d'égalité par coalescence nulle
   (`?? null`), pour que « absent » et « undefined » soient la même
   politique et différente de toute valeur.
3. **Grille §4** : consigner `takes`/`stops` par fenêtre a posteriori
   depuis les enregistrements de trades (aucun changement de schéma),
   afin de distinguer les deux mécanismes d'échec possibles.

## Verdict

APPROUVÉ. Le changement est additif : un champ optionnel, zéro
transition, zéro événement, sémantique d'ambiguïté héritée. Le risque
d'implémentation principal (égalité TRAILING à étendre — L113-115 ne
compare que `trailBps`) est couvert par TT5 et les tests.
