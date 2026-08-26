# Review — H-P2, sélecteur de permission conditionné au régime du train

Statut : APPROUVÉ AVEC CORRECTIONS (mineures — intégrées au modèle)
Date : 2026-08-26
Modèle : `models/regime-aware-selector.md`

Fichiers vérifiés : `models/strategy-permission.md` (intégralité),
`packages/backtest/scripts/regime-permission-walkforward-p2.ts` (498 lignes),
`models/weak-year-diagnosis.md` §6.1/§6.4, `models/signal-edge-inventory.md`.

## Checklist

### Indépendance de la justification (§2)
- [x] Aucun résultat de grille D3-P/D3-P2 §8/§11 cité — vérifié mot par mot.
- [x] Sources exclusivement antérieures ou code (M1/M5 mesurés avant
      conception des candidats ; §1-§4 de strategy-permission ; code).
- [x] Contrôles de câblage D3-P2 cités comme preuve de mécanisme, pas de
      performance.
- [x] Seuil 0,5 posé ex ante (majorité simple), aucun balayage.
- [x] Non-prétention explicite : pas de prévision de flip ; le fold
      2020→2021 est nommé comme cas d'échec par construction.
- [x] Zéro fit sur le near-miss (3/6 jamais cité dans la justification).

### Cohérence avec strategy-permission.md
- [x] Candidats {C0, C1, C2} — identiques §4.
- [x] Portes D3-P2 : dd ≤ 10 %, turnover ≤ 10, feeRate ≤ 1 %, run actif —
      identiques §10 et au script P2 L248-254.
- [x] Folds propres {2023, 2025} exclus — identique.
- [x] WF3 baselines et tolérance 5e-5 — identiques (script P2 L68-75,
      L378-379).
- [x] Compteurs INV-P6 référencés (replay.ts L337-342, L702-705, L867-868).
- [x] Config V1 bit-identique (script P2 L87-121).

### Règle R-H2 (§3)
- [x] Fonction pure, déterministe, un seul degré de liberté.
- [x] C1 jamais sélectionné (justification second seuil).
- [x] Défaut conservateur C0 dans tous les cas ambigus.
- [x] Cas limite 2016 indisponible — traité après correction C2.

### Critères §5 et verrou §6
- [x] W1-r/W2-r/W3-r conjoints stricts ; VALIDÉ = W1-r ∧ W2-r ∧ W3-r ∧
      WF3-R, tout autre = DÉCLASSÉ → H-P0′.
- [x] Verrou épistémique strict : VALIDÉ ne déploie rien, seule suite =
      réplication H-D1 ; interdiction de recalibrage post-lecture.
- [x] Folds à spread nul explicités après correction C3.

### Implémentabilité (§7)
- [x] `daysByRegimeByYear` (script P2 L277, L298-303), `regimeTimeline`
      (L178-213), `CANDIDATE_KEYS` (L39-58), `selectOnTrain` réutilisable,
      INV-P6 exposé (L241, L409-413), WF3 codé (L68-75, L370-385).
- [x] Le script annoncé est un miroir de P2 — scaffolding complet.

### Style maison
- [x] Français, statut SPÉCIFIÉ, critères a priori, §8 à compléter, §9
      hors périmètre.

## Corrections demandées (appliquées au modèle avant exécution)

1. **§3** : ajouter `signalsPassed > 0` aux portes (miroir exact du script
   P2 L253).
2. **§4** : expliciter le scénario 2016 indisponible — 9 fenêtres utiles,
   5 folds propres, seuil ≥ 4 inchangé ; élimination des folds dont le
   train/test est indisponible.
3. **§5 W2-r** : un fold à sélection identique R-H2/argmax produit un
   spread de 0 et ne compte pas comme « bat » (folds descriptifs :
   coïncidence fréquente = redondance, pas nocivité).

## Risques résiduels assumés

- Persistance interannuelle non démontrée : H-P2 mesure le transfert OOS,
  pas la persistance ; la réplication H-D1 (produits à histoire non
  superposable) est la réponse.
- Seuil 0,5 non optimal par construction : choix ex ante, faux négatif
  accepté, balayage interdit.
- Si R-H2 réussit, le parallèle interprétatif avec le near-miss D3-P2 sera
  tentant : le verrou §6 l'interdit jusqu'à réplication.
