# Revue de la confirmation cross-actifs

Le protocole répond à la limite principale de l'étude de sélection : il garde
`POWER_THIRD` et les seuils inchangés tout en déplaçant l'évaluation vers deux
produits absents des artefacts locaux recensés. Le choix ALGO/FIL est fait avant
lecture des bougies. La revue interdit de substituer un actif si l'historique
est incomplet ou si le résultat est défavorable.

## Cas nominal

Les 16 datasets primaire/exécution sont chargés, puis les deux profils sont
exécutés sur les huit run keys. Le cœur reçoit exactement 32 observations et
huit preuves d'invariant. Une preuve valide mène à `CONFIRMED` ou
`NOT_CONFIRMED`; les deux verdicts restent `RESEARCH_ONLY`.

## Erreurs et preuves invalides

Le modèle refuse explicitement :

- une liste de run keys vide, dupliquée ou contenant une clé vide ;
- une observation absente ou dupliquée ;
- un profil autre que `IDENTITY` ou `POWER_THIRD` ;
- une stratégie autre que EMA ou breakout ;
- un compteur non entier, négatif ou incohérent (`BUY + SELL != actifs`) ;
- une distribution présente sans signal actif, absente avec activité, non finie
  ou dont le p95 est inférieur à la médiane ;
- un taux hors `[0, 1]`, un drawdown hors `[0, 1]`, un turnover ou des frais
  négatifs/non finis ;
- un nombre d'évaluations ou une décomposition active/BUY/SELL différente entre
  baseline et calibration ;
- un benchmark ou un scénario RSI différent entre profils ;
- une preuve d'invariant de run absente, dupliquée ou inconnue.

Ces cas produisent `INVALID_CONFIDENCE_CALIBRATION_CONFIRMATION_EVIDENCE` et non
un verdict `NOT_CONFIRMED` : une absence de preuve ne vaut pas une réfutation.

## Verdict négatif valide

Une matrice complète peut produire `NOT_CONFIRMED` pour les motifs fermés
suivants : run inactif, médiane agrégée hors bande, couverture de runs sous 75%,
plafonnement, rejet risque, drawdown, turnover ou frais au-delà des limites.
Tous les motifs applicables sont conservés ; aucun ordre de priorité textuel ne
masque une deuxième défaillance.

Les bornes sont inclusives : 100 et 400 USD, 75%, 10 de turnover, 10% de
drawdown et 1% de frais passent. Tout dépassement strict échoue.

## Annulation, retry et terminalité

Le runner n'a pas d'état repris automatiquement. Une interruption ou une erreur
réseau termine l'exécution sans nouvel artefact final. Une relance recommence le
protocole complet avec les mêmes constantes et écrit le résultat final par
remplacement atomique. Aucun retry ne change les produits, folds, profils ou
seuils.

## Permissions et isolation

L'étude ne lit que les données publiques de marché et n'accède à aucun compte,
ordre ou secret de trading. Les résultats restent dans `.artifacts/studies/`,
hors du code live. Le CLI général conserve `IDENTITY` par défaut ; ce protocole
n'en modifie pas le comportement.

## Limites connues

L'absence d'ALGO/FIL dans les artefacts locaux ne garantit pas une ignorance
humaine ou externe totale. Les deux actifs restent des crypto-actifs corrélés et
ne constituent pas une validation multi-classe d'actifs. Huit runs ne permettent
pas d'inférence statistique robuste. Enfin, confirmer une échelle d'exposition
ne confirme ni l'alpha, ni la liquidité live, ni la rentabilité future.
