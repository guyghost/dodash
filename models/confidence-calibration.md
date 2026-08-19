# Modèle de calibration de confiance

La calibration est une transformation pure, monotone et bornée de la confiance
émise par une stratégie. Elle sert uniquement aux expériences de backtest : elle
ne modifie ni la direction du signal, ni sa raison, ni son sizing notionnel, et
n'autorise aucune transition vers le trading live.

## Profils fermés

Les seuls profils acceptés sont :

- `IDENTITY` : `calibrated = raw` ;
- `POWER_HALF` : `calibrated = raw^(1/2)` ;
- `POWER_THIRD` : `calibrated = raw^(1/3)` ;
- `POWER_QUARTER` : `calibrated = raw^(1/4)`.

Une confiance brute doit être finie et appartenir à `[0, 1]`. Un profil inconnu
ou une confiance invalide produit un `Result` d'erreur explicite ; aucune valeur
par défaut et aucun clamp silencieux ne sont permis.

Pour tout profil, `0` reste `0`, `1` reste `1` et l'ordre relatif de deux
confiances valides est conservé. Pour `raw` dans `(0, 1)`, un exposant plus petit
produit une calibration au moins aussi forte.

## Application aux stratégies

La suite comparative applique le profil choisi aux signaux actifs de
`ema-cross` et `breakout`. `rsi-reversion` reste en `IDENTITY` et sert de
référence d'échelle. Le même profil est appliqué aux deux stratégies calibrées :
une recherche de paramètres propre à chaque stratégie est hors périmètre.

Un signal `HOLD` est retourné sans modification. Pour `BUY` ou `SELL`, seuls les
bits de `confidence` changent. `strategyId`, `productId`, `side`, `reasonCode` et
`suggestedSize` sont conservés exactement. L'allocator reste l'unique composant
qui pondère ensuite la taille par cette confiance.

`IDENTITY` est le chemin de compatibilité. Le CLI l'utilise par défaut et garde
les identifiants et noms d'artefacts historiques. Tout profil non identité est
encodé explicitement dans le `runId`, le chemin de rapport et le manifeste.

## Expérience walk-forward figée

L'étude de calibration utilise :

- produits de développement : `ETC-USD` et `ATOM-USD` ;
- folds de développement : `2022-08-19/2023-08-19`,
  `2023-08-19/2024-08-19` et `2024-08-19/2025-08-19` ;
- holdout : `2025-08-19/2026-08-19` ;
- décisions `ONE_DAY`, exécution `SIX_HOUR`, marché `SPOT_LONG_ONLY` ;
- notionnel cible 1 000 USD, capital initial 10 000 USD, frais 6 bps,
  slippage 2 bps, stop fixe 150 bps et objectif fixe 300 bps ;
- limites d'allocation et de risque identiques entre profils.

Les quatre profils sont évalués sur les six couples produit/fold de
développement. Le holdout n'est chargé qu'après la sélection et ne participe
jamais au classement. Seuls `IDENTITY` et le profil sélectionné sont ensuite
évalués sur le holdout.

## Politique de sélection

Le grain d'une observation de développement est
`profil × produit/fold × stratégie calibrée`. Chaque profil doit donc posséder
exactement douze observations : six pour `ema-cross` et six pour `breakout`.

Pour chaque stratégie, le résumé calcule la médiane non pondérée des six
notionnels médians demandés. Le poids égal par produit/fold empêche qu'un marché
plus actif domine la sélection.

Un profil est éligible si et seulement si :

1. chaque observation contient au moins un signal actif et un notionnel médian
   demandé strictement positif ;
2. les deux médianes agrégées appartiennent à `[100, 400]` USD ;
3. aucun signal n'est plafonné par l'allocation ou réduit par le risque ;
4. le drawdown maximal observé ne dépasse pas `10%` ;
5. le turnover maximal ne dépasse pas `10` fois le capital initial ;
6. les frais maximaux ne dépassent pas `1%` du capital initial.

Le PnL, le rendement, le Sharpe, le win rate et le profit factor ne participent
pas au classement. Parmi les profils éligibles, le profil le moins
interventionniste gagne dans l'ordre `IDENTITY`, `POWER_HALF`, `POWER_THIRD`,
`POWER_QUARTER`. Si aucun profil n'est éligible, la sélection vaut `null`, le
holdout n'est pas chargé et l'étude se termine en résultat négatif explicite.

## Métriques de coût

Le turnover d'un scénario vaut :

`sum(abs(fill.price × fill.quantity)) / initialCapital`.

Le notionnel échangé brut est la somme du numérateur. Les frais sont la somme
des frais de fill déjà comptabilisés. Ces mesures utilisent uniquement des fills
papier réellement produits ; elles ne remplacent pas les diagnostics
d'intention au close.

## Invariants

1. La calibration n'introduit aucun état, horloge, I/O ou dépendance LLM.
2. La direction et le nombre de signaux actifs sont identiques entre profils.
3. Le sizing cible avant pondération reste identique entre profils.
4. Le holdout ne peut influencer ni l'éligibilité ni la sélection.
5. Toute observation manquante, dupliquée ou non finie invalide la sélection.
6. Un résultat d'étude reste `RESEARCH_ONLY` et ne peut activer le live.
