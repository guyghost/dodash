# Revue de la sensibilité aux estimateurs de quantile

## Biais et cas nominal

Le protocole sépare deux questions : la sensibilité méthodologique sur les mêmes
distributions XTZ/ZEC, puis la stabilité externe sur GRT/MANA. La convention
`NEAREST_RANK` est choisie avant les nouvelles données et ne peut être remplacée
si une autre convention rend XTZ/ZEC plus favorable. Les quatre estimateurs
reçoivent les mêmes tableaux bruts ; aucune reconstruction depuis
`min/médiane/p95/max` n'est admise.

L'étude garde la médiane R7 afin de modifier une seule convention à la fois. Les
limites 600 et 2, le profil, les folds et tout le pipeline de marché restent
inchangés. Les actifs externes absents localement réduisent la réutilisation
directe des données d'étude, sans prouver une ignorance humaine ou externe.

L'instance MKR/COMP est auditée comme un échec de disponibilité, pas comme un
résultat défavorable. Sa terminalité interdit de la prolonger avec un autre
actif. GRT/MANA appartient à une nouvelle instance pré-enregistrée, dont la seule
modification est la paire externe et dont l'historique conserve la cause exacte
du redémarrage. Aucun échantillon GRT/MANA n'a été lu avant ce choix.

## Erreurs et preuves invalides

Le cœur refuse : estimateur ou profil inconnu, probabilité hors `[0,1]`, run key
vide/dupliquée, case absente/dupliquée, stratégie inconnue, compteur incohérent,
échantillon non fini ou non positif, longueur différente du nombre actif,
échantillons présents pour un run inactif, taux hors domaine, invariant absent
ou faux, ou divergence de population entre profils. Il vérifie aussi que la
médiane et le p95 R7 reconstruits satisfont le contrat parent.

Ces erreurs produisent
`INVALID_CONFIDENCE_QUANTILE_SENSITIVITY_EVIDENCE`. Une preuve incomplète ne
vaut ni désaccord méthodologique ni réfutation externe.

## Bornes et conventions

Les séries vides n'ont pas de quantile. Une série à une valeur retourne cette
valeur pour les quatre conventions. À `q=0`, toutes retournent le minimum ; à
`q=1`, toutes retournent le maximum. Pour `[1,2,3,4]` à `q=0.95`, R7 vaut
`3.85`, nearest-rank et higher valent `4`, lower vaut `3`.

Les seuils sont inclusifs : 600 USD et ratio 2 passent ; tout dépassement strict
échoue. Le ratio n'est calculé que pour une population active dont la médiane R7
est strictement positive.

## Annulation, retry, permissions et terminalité

Une interruption, une erreur réseau ou un replay en échec termine l'exécution
sans nouvel artefact final. Une relance recommence tout le protocole avec les
mêmes constantes et remplace le résultat seulement par renommage atomique. Il
n'existe aucun checkpoint décisionnel, fallback de timeframe, substitution
d'actif ou ajustement automatique.

L'étude lit uniquement des données publiques et écrit sous
`.artifacts/studies/`. Elle ne possède aucune permission de compte ou d'ordre.
`INVALID_EVIDENCE` et `COMPLETED` sont terminaux. `TAIL_CONFIRMED` et
`TAIL_NOT_CONFIRMED` n'acceptent que `ARTIFACT_WRITTEN`, qui mène à
`COMPLETED` ; aucun autre événement ne peut en sortir.

## Limites

Quatre conventions ne couvrent pas toute la taxonomie des quantiles. Les petits
échantillons rendent précisément leur différence plus visible mais ne créent
pas de puissance statistique. Deux nouveaux crypto-actifs restent corrélés au
même univers et huit run keys ne prouvent pas une stabilité générale. Enfin,
une queue de notionnel bornée ne prouve ni liquidité, ni alpha, ni rentabilité
future.
