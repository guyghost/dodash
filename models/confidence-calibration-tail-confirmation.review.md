# Revue de la confirmation de queue

Cette revue vérifie la politique définie dans
`confidence-calibration-tail-confirmation.md`. La décision reste une extension
du modèle médian : elle ne réinterprète pas le verdict ALGO/FIL et ne change pas
`POWER_THIRD`.

## Cas nominal

Les 16 datasets primaire/exécution sont chargés pour XTZ/ZEC. Les deux profils
sont exécutés sur huit run keys, donnant exactement 32 observations et huit
invariants. Le cœur parent valide la preuve et confirme d'abord l'échelle
médiane. Le cœur de queue vérifie ensuite les 16 p95 et ratios `POWER_THIRD`.

Si les trois règles passent, le verdict est `TAIL_CONFIRMED`; sinon il est
`TAIL_NOT_CONFIRMED`. Les deux sont terminaux, descriptifs et `RESEARCH_ONLY`.

## Erreurs et preuve invalide

Toutes les erreurs fermées du modèle parent restent invalidantes : run key
vide/dupliquée, combinaison absente/dupliquée, profil ou stratégie inconnu,
compteur incohérent, distribution invalide, taux hors domaine, population de
signaux modifiée, benchmark/RSI différent ou invariant de run absent.

Le cœur de queue refuse également un résultat parent invalide. Ces cas
produisent `INVALID_CONFIDENCE_CALIBRATION_TAIL_CONFIRMATION_EVIDENCE`, jamais
`TAIL_NOT_CONFIRMED`. Le shell refuse aussi un scénario ou diagnostic manquant.

## Verdict négatif valide

Une preuve complète peut produire un ou plusieurs motifs :

- `BASE_CONFIRMATION_FAILED` si l'échelle médiane ou un garde-fou parent échoue ;
- `P95_NOTIONAL_LIMIT` si au moins un p95 dépasse strictement 600 USD ;
- `P95_MEDIAN_RATIO_LIMIT` si au moins un ratio dépasse strictement 2.

Les limites sont inclusives. Le cœur conserve simultanément les motifs p95
absolu et relatif lorsqu'ils s'appliquent. Un échec ne déclenche ni retrait de
run, ni changement d'actif, ni ajustement de seuil.

## Annulation, retry et terminalité

Une interruption ou une erreur réseau termine le runner sans nouvel artefact
final. Une relance recommence le protocole complet avec les constantes figées.
L'écriture temporaire est supprimée en cas d'échec et le résultat final est
remplacé atomiquement. Aucun retry ne modifie produits, folds ou critères.

`INVALID_EVIDENCE`, `COMPLETED/TAIL_CONFIRMED` et
`COMPLETED/TAIL_NOT_CONFIRMED` sont terminaux.

## Permissions et isolation

L'étude utilise uniquement des bougies publiques et n'accède à aucun compte,
ordre ou secret. Le nouvel artefact reste sous `.artifacts/studies/`. Le CLI et
la configuration live restent inchangés ; `IDENTITY` demeure leur défaut.

## Limites connues

Deux crypto-actifs et huit runs ne constituent pas une validation statistique
ou multi-classe. Le plafond 600 USD est une règle de risque choisie, pas une
estimation probabiliste optimale. Le p95 empirique est sensible aux petits
échantillons de signaux. Enfin, une queue bornée ne démontre ni alpha, ni
liquidité live, ni rentabilité future.
