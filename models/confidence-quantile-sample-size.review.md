# Revue du modèle d’audit de résolution p95

## Cas nominal et absence de re-sélection

Le protocole garde l’estimateur, les deux bornes et les mêmes distributions de
signaux. Le cœur calcule la résolution du rang à partir du compteur actif et
compare les conventions discrètes uniquement pour diagnostiquer leur
sensibilité. Un résultat favorable de `LOWER` ou `HIGHER` n’a aucun chemin de
transition vers la politique sélectionnée.

Les seuils de classe ne sont pas ajustés après observation : ils proviennent du
nombre exact de valeurs au-dessus de `ceil(0.95 × n)`. La séparation
`MAXIMUM / ONE_ABOVE / TWO_OR_MORE_ABOVE` évite ainsi un découpage arbitraire
choisi pour améliorer le résultat.

## Erreurs, cas limites et preuves invalides

Le modèle couvre `n = 0`, `n = 1`, les frontières `n = 19`, `20`, `39` et `40`,
ainsi que les égalités exactes aux bornes 600 et 2. Les bornes restent
inclusives ; seul un dépassement strict est compté. Une médiane nulle est
impossible avec les échantillons positifs et reste néanmoins rejetée si un
appelant viole ce contrat.

Une matrice incomplète, dupliquée ou portant une population/run key/stratégie
inconnue produit `INVALID_CONFIDENCE_QUANTILE_SAMPLE_SIZE_EVIDENCE`. Une case
inactive avec des valeurs, ou une case active sans exactement `n` valeurs,
échoue avant tout résumé. Les nombres `NaN`, infinis, nuls ou négatifs sont
interdits.

## Source moins corrélée et comparabilité

Une paire crypto supplémentaire ne satisfait pas le critère inter-univers.
Une API connue mais non configurée, payante, sans credential, sans profondeur
historique complète ou sans grain 6 h comparable n’est pas une source
disponible. Le statut `NOT_EXECUTED_SOURCE_UNAVAILABLE` est donc un résultat de
couverture, pas une confirmation ni une réfutation du protocole.

Ajouter ultérieurement un adapter externe constitue une nouvelle étape : il
faudra pré-enregistrer la source, l’univers, la paire et les règles
d’ajustement avant de lire ses prix. Cette instance ne peut pas choisir une
paire après inspection de ses résultats.

## Annulation, retry, permissions et terminalité

Une interruption de lecture ou d’écriture termine le processus sans remplacer
l’artefact existant. Une relance recommence depuis `CREATED` avec les mêmes
constantes. Il n’existe ni checkpoint décisionnel, ni retry qui change un
paramètre, ni fallback de timeframe ou de fournisseur.

L’étude ne requiert que la lecture de données publiques déjà présentes et
l’écriture sous `.artifacts/studies/`. Elle ne possède ni credential de compte,
ni permission d’ordre. `COMPLETED` et `INVALID_EVIDENCE` sont terminaux.

## Interprétation et risques résiduels

Une forte étendue discrète dans `MAXIMUM` ou `ONE_ABOVE` montre une faible
résolution empirique ; elle ne mesure pas une incertitude fréquentiste complète
et ne remplace pas un intervalle de confiance. Inversement, l’absence de
désaccord de verdict ne prouve pas que la queue est stable hors échantillon.

Le notionnel demandé est un signal de dimensionnement théorique. Même borné, il
ne tient pas compte du carnet, du spread réel, de l’impact de marché ou de la
capacité. L’étude n’observe pas non plus l’alpha : PnL, Sharpe, win rate et
profit factor restent volontairement hors décision.
