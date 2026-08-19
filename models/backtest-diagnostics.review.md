# Revue du diagnostic d’exposition

Le grain sépare explicitement les évaluations de stratégie des opportunités
nettes. Un `HOLD` augmente le dénominateur du taux d’activité mais jamais les
distributions actives. Deux signaux opposés peuvent augmenter leurs compteurs
actifs tout en ne créant aucune opportunité d’allocation après compensation ;
ce n’est ni une perte d’observation ni un plafond.

Les cas vides sont définis : taux nuls, compteurs nuls et statistiques `null`.
Les cas à une observation, effectifs pairs/impairs et p95 interpolé sont
déterministes. Les entrées `NaN`, infinies, négatives, les identifiants vides,
les prix nuls, les confiances hors bornes, un `HOLD` non nul et tout ordre des
notionnels contraire au pipeline sont refusés.

Le diagnostic distingue trois explications qui ne doivent pas être confondues :

- une faible confiance réduit le notionnel demandé avant toute limite ;
- l’allocator peut réduire ce notionnel par le cash, le seuil minimal ou
  `maxDecisionNotional` ;
- le moteur de risque peut ensuite rejeter l’ordre alloué.

Le taux de plafonnement utilise uniquement les opportunités nettes comme
dénominateur. Le taux de rejet risque utilise uniquement les opportunités ayant
produit un ordre alloué. Une absence d’ordre due à la compensation ou à
`minNetQuantity` n’est donc pas attribuée au risque.

Le prix de référence reste le close primaire qui a servi à l’allocation. Le
slippage, le gap jusqu’à l’open suivant, les caps Spot appliqués au broker et les
sorties protectrices peuvent modifier le fill réel ; le rapport doit conserver
cette limitation près de toute conclusion sur « l’exposition effective ».

La dernière bougie est incluse dans les signaux et intentions diagnostiqués mais
ne peut toujours pas produire de fill. Ce choix mesure le comportement de
décision indépendamment de la disponibilité d’une bougie future et doit rester
stable entre actifs comparés.

Le cœur de calcul reste pur et sans I/O. Le replay ne fait que collecter les
observations déjà validées par les domaines stratégie, allocation et risque,
puis consomme le résumé du modèle. Une erreur de résumé emprunte le chemin
d’échec déterministe existant ; aucun fallback, retry ou texte libre ne décide
de poursuivre.

La capture brute est volontairement opt-in. Elle réutilise exactement les
observations validées du résumé, exclut `HOLD`, conserve l'ordre temporel et
refuse toute valeur non finie ou négative. Une erreur de projection emprunte
le même échec `DIAGNOSTICS_FAILURE`; elle n'est jamais masquée par un tableau
vide. La suite propage l'option à tous ses scénarios et expose soit une projection
complète, soit `null`, sans état intermédiaire ambigu. Les tests rapprochent les
échantillons du résumé R7 afin d'interdire une seconde définition implicite du
notionnel demandé.

Cette donnée supplémentaire reste une intention calculée au close primaire. Sa
présence n'autorise aucune transition live et ne doit pas être activée dans les
artefacts généraux pour lesquels les distributions agrégées suffisent.
