# Revue du modèle de résolution multi-timeframe

| Cas | Décision explicite |
| --- | --- |
| Série d’exécution absente | planning `1:1`, compatibilité historique |
| Une seule bougie primaire avec série secondaire | rejet : durée primaire non inférable |
| Intervalles primaires irréguliers | rejet avant replay |
| Intervalles d’exécution irréguliers | rejet avant replay |
| Intervalle d’exécution égal ou supérieur | rejet du ratio |
| Ratio non entier | rejet du ratio |
| Première sous-bougie décalée | rejet d’alignement |
| Sous-bougie manquante, dupliquée ou supplémentaire | rejet d’alignement |
| Dernière bougie primaire partiellement couverte | rejet d’alignement |
| Open, close, high ou low incohérent | rejet d’agrégation |
| Volume différent entre granularités | accepté : non consommé par l’exécution protectrice |
| Gap sur première sous-bougie | trigger avant ordre de stratégie primaire |
| Achat à l’open primaire | bracket armé avant la première plage fine |
| Trigger dans une sous-bougie ultérieure | fill au timestamp fin, aucune stratégie |
| Position survivante au jour | acteur poursuit sur les sous-bougies suivantes |
| Politique `NONE` avec résolution fine | résultat historique identique |
| Erreur de planning | replay fermé, aucun retry implicite |

La série fine est une source de résolution, pas une nouvelle horloge de
décision. Cette séparation interdit de recalculer RSI, ADX, VWAP, risque ou
allocation quatre fois par jour lorsqu’un manifeste quotidien demande
uniquement une meilleure fidélité d’exécution. Puisque seuls `open`, `high` et
`low` sont consommés par les événements protecteurs, une divergence de volume
entre granularités n’est pas autorisée à piloter l’état du replay.

Le planning est produit par une fonction pure retournant un résultat typé. Le
shell du replay valide les séries de marché, consomme les groupes dans l’ordre
et envoie les événements existants à `protectiveOrder`. Aucune nouvelle logique
de déclenchement n’est dupliquée hors de la machine protectrice.

La revue couvre nominal, compatibilité, trous, chevauchements, bornes,
agrégation, erreurs, état terminal et séparation des timeframes. Les deux
datasets et leurs empreintes doivent figurer dans tout artefact de recherche
multi-timeframe.
