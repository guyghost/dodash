# Modèle du diagnostic d’exposition du backtest

Le diagnostic est une projection déterministe du replay. Il explique comment
les signaux deviennent — ou ne deviennent pas — une exposition planifiée. Il ne
crée aucun nouvel état du workflow et n’autorise aucune transition vers le live.

## Grain des observations

Deux populations distinctes sont observées :

1. une observation de signal par stratégie et par bougie primaire éligible à une
   décision, y compris lorsque le signal vaut `HOLD` et lorsque la bougie est la
   dernière du dataset ;
2. une observation d’allocation par bougie où la quantité nette absolue dépasse
   `minNetQuantity` après pondération par la confiance et compensation des
   signaux opposés.

Les signaux antérieurs au warmup ne font partie d’aucune population. Une
observation d’allocation sur la dernière bougie mesure une intention approuvée,
pas un fill : l’absence de bougie suivante reste gouvernée par
`backtest-run.md`.

## Mesures par stratégie

Pour chaque `strategyId`, trié de manière déterministe, le rapport expose :

- `evaluationCount`, `activeSignalCount`, `buySignalCount` et
  `sellSignalCount` ;
- `activeSignalRate = activeSignalCount / evaluationCount`, ou `0` sans
  évaluation ;
- la distribution de confiance des seuls signaux actifs ;
- la distribution du notionnel demandé par les seuls signaux actifs :
  `suggestedSize × confidence × primaryClose`.

Une distribution contient `count`, `min`, `median`, `p95` et `max`. Sans
observation, ses quatre valeurs statistiques sont `null`. La médiane et le p95
utilisent l’interpolation linéaire à la position `(n - 1) × q` dans la série
triée, avec `q = 0.5` ou `0.95`.

Pour les études pré-enregistrées qui doivent auditer une convention de quantile,
le replay peut recevoir l'option explicite `includeDiagnosticSamples`. Elle
ajoute alors une projection `diagnosticSamples` contenant, pour chaque stratégie
triée, les seuls notionnels demandés actifs dans l'ordre d'évaluation. L'option
est `false` par défaut et la projection vaut alors `null` : les résultats et
artefacts ordinaires ne grossissent pas implicitement. Cette projection ne
modifie ni le résumé R7 existant, ni les signaux, ni l'allocation, ni les fills.

## Mesures d’allocation par scénario

Pour chaque opportunité nette, le replay observe successivement :

- `requestedNetNotional` : quantité nette absolue multipliée par le close de
  décision ;
- `allocatedNotional` : somme des ordres produits par l’allocator, au même
  close, après cash, `maxDecisionNotional` et seuil minimal ;
- `riskApprovedNotional` : somme des ordres qui restent après les décisions du
  moteur de risque, toujours au close de décision.

Le résumé expose les trois distributions ainsi que :

- `opportunityCount` ;
- `cappedCount` et `capRate = cappedCount / opportunityCount` ;
- `riskEvaluationCount`, nombre d’opportunités avec un notionnel alloué
  strictement positif ;
- `riskRejectedCount` et
  `riskRejectionRate = riskRejectedCount / riskEvaluationCount`.

Une allocation est plafonnée lorsque `allocatedNotional` est inférieur au
notionnel demandé au-delà de la tolérance numérique. Une évaluation risque est
rejetée lorsque son notionnel approuvé est inférieur à son notionnel alloué
au-delà de cette même tolérance. La tolérance vaut
`max(1, referenceNotional) × Number.EPSILON × 64`.

## Évaluation v2 — métriques primaires et régime du benchmark

L'évaluation d'un run distingue deux niveaux de lecture. Les métriques
primaires décrivent le résultat absolu ; les métriques contextuelles relient
ce résultat à son marché. Seules les métriques primaires peuvent soutenir un
verdict.

### Métriques primaires

Pour chaque scénario d'un run, l'évaluation rapporte exactement : le PnL
absolu net, en dollars et en fraction du capital initial, réalisé et latent
distincts ; le win rate liquidatif (INV-26, `backtest-run.md`) ; le drawdown
maximal ; le Sharpe annualisé ; le turnover ; les frais payés.

### Métrique contextuelle : excess vs benchmark

L'excess vs benchmark est rétrogradé en métrique contextuelle : perdre moins
que le benchmark n'est pas un résultat positif en absolu. Il ne soutient
aucun verdict et n'est rapporté qu'accompagné du régime du benchmark.

Le régime du benchmark est calculé, jamais déclaré à la main. Il dérive du
rendement total du benchmark buy-and-hold sur exactement la même fenêtre, au
seuil figé à zéro : rendement `>= 0` vaut `HAUSSIER`, rendement `< 0` vaut
`BAISSIER`. Le seuil fait partie du modèle ; un rapport dont le régime ne
provient pas de ce calcul est invalide.

### Règle de lecture

Ces métriques décrivent des faits absolus. Elles n'activent aucune stratégie,
ne déclarent aucun edge et n'autorisent aucune transition vers le live. Un
PnL positif en marché haussier, comme un excess positif en marché baissier,
reste un fait mesuré.

### Compatibilité de lecture des artefacts existants

Les artefacts produits avant cet amendement peuvent omettre le win rate
liquidatif ou le régime du benchmark. Leur lecture ne échoue pas : une
métrique absente reste absente (`null`), sans valeur reconstituée, inférée
ni réinterprétée. Le régime d'un artefact legacy est recalculé depuis son
benchmark, jamais repris d'un champ absent.

## Validation et erreurs

Les identifiants doivent être non vides, les prix finis et strictement positifs,
les confiances dans `[0, 1]`, et les tailles/notionnels finis et positifs ou nuls
selon leur définition. `HOLD` exige une taille nulle. Les étapes successives ne
peuvent augmenter le notionnel :

`0 <= riskApprovedNotional <= allocatedNotional <= requestedNetNotional`.

Une observation invalide produit un `Result` d’erreur explicite. Le replay
échoue avec `DIAGNOSTICS_FAILURE` plutôt que de publier un rapport partiel ou de
remplacer une valeur invalide par zéro.

## Invariants

1. `activeSignalCount = buySignalCount + sellSignalCount`.
2. Les distributions de confiance et de notionnel demandé ont exactement
   `activeSignalCount` observations.
3. `0 <= activeSignalRate <= 1`, `0 <= capRate <= 1` et
   `0 <= riskRejectionRate <= 1`.
4. `cappedCount <= opportunityCount` et
   `riskRejectedCount <= riskEvaluationCount <= opportunityCount`.
5. Les trois distributions d’allocation ont exactement `opportunityCount`
   observations.
6. Les statistiques décrivent des intentions au close primaire ; elles ne sont
   ni des fills, ni une preuve de liquidité, ni une autorisation de trading live.
7. Si les échantillons sont demandés, chaque tableau a exactement
   `activeSignalCount` valeurs finies et positives ou nulles et reproduit le
   `count`, le `min`, la médiane R7, le p95 R7 et le `max` du résumé.
8. Sans option explicite, `diagnosticSamples = null` au niveau replay et suite.
9. Le régime du benchmark d'une évaluation est dérivé du rendement du
   benchmark par le seuil figé à zéro ; il n'est jamais un paramètre d'entrée
   ni une valeur déclarée.
10. Une métrique primaire absente d'un artefact legacy reste `null` à la
    lecture ; aucune valeur n'est reconstituée et aucun verdict n'est porté
    sur les seules métriques contextuelles.
