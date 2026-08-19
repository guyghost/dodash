# Modèle du moteur d’indicateurs

Le moteur transforme une série OHLCV validée et, facultativement, des transactions et un carnet d’ordres validés en un instantané déterministe. Les prédicats numériques vivent en Prolog et Tau-Prolog est embarqué comme moteur de calcul, jamais comme service réseau.

## Entrée

- Série de chandelles validée, strictement croissante.
- Paramètres entiers positifs : périodes RSI, EMA rapide, EMA lente, ATR, volatilité historique, momentum, VWAP OHLCV, volume relatif, tendance du volume et force de tendance.
- Liste non vide, strictement croissante et sans doublon des horizons de rendements périodiques.
- Seuil de pic de volume strictement positif.
- L’EMA rapide doit être strictement inférieure à l’EMA lente.
- Contexte microstructurel facultatif :
  - transactions avec prix et quantité strictement positifs ;
  - niveaux bid et ask avec prix et quantité strictement positifs ;
  - meilleur bid inférieur ou égal au meilleur ask.

## Sortie

`IndicatorSnapshot` contient :

- `rsi`
- `emaFast`
- `emaSlow`
- `macd` (`emaFast - emaSlow`)
- `atr` de Wilder
- `historicalVolatility`
- `momentum`
- `periodicReturns`
- `ohlcvVwap`
- `tradeVwap`
- `orderBookVwap` (`bid`, `ask`, `mid`)
- `bidAskSpread` (`absolute`, `bps`)
- `relativeVolume`
- `volumeSpike`
- `volumeTrend`
- `vwapDeviation`
- `trendStrength`
- l’instant de la dernière chandelle
- un identifiant déterministe de snapshot

## Sémantique

- RSI utilise les gains/pertes moyens de la fenêtre demandée ; une fenêtre plate vaut `50`, sans perte `100`, sans gain `0`.
- EMA utilise `alpha = 2 / (période + 1)` et la première clôture comme seed.
- ATR utilise le lissage de Wilder : moyenne des premiers true ranges, puis `(ATR précédent × (période - 1) + TR courant) / période`.
- MACD est la différence entre les EMA rapide et lente.
- La volatilité historique est l’écart-type d’échantillon des log-rendements sur la fenêtre demandée. Elle reste exprimée par période et n’est pas annualisée par le moteur.
- Le momentum est la différence absolue entre la dernière clôture et celle située à `momentumPeriod` périodes.
- Chaque rendement périodique vaut `close courant / close décalé - 1`.
- Le VWAP OHLCV utilise le prix typique `(high + low + close) / 3`, pondéré par le volume, sur sa fenêtre.
- Le VWAP des transactions pondère les prix des transactions par leurs quantités.
- Le VWAP du carnet calcule séparément les moyennes pondérées des niveaux bid et ask fournis ; `mid` est leur moyenne. Il ne réutilise jamais les transactions ou les volumes OHLCV.
- Le spread est `meilleur ask - meilleur bid`; sa valeur en points de base est rapportée au midpoint des meilleurs prix.
- Le volume relatif compare le volume courant à la moyenne des `relativeVolumePeriod` chandelles précédentes, chandelle courante exclue.
- Un pic de volume est vrai si le volume relatif est supérieur ou égal au seuil configuré.
- La tendance du volume est la pente de régression linéaire des volumes, normalisée par leur moyenne ; elle est exprimée en variation relative par chandelle.
- La déviation VWAP vaut `close courant / ohlcvVwap - 1`.
- La force de tendance est l’ADX de Wilder sur la période configurée, borné entre `0` et `100`. Le snapshot utilise une fenêtre glissante des `2 × période` dernières chandelles : les premiers `p` mouvements initialisent les lissages directionnels, puis les `p` valeurs DX initialisent et produisent l’ADX courant.
- Un indicateur dont le dénominateur de volume est nul vaut `null`. Les sorties transactions/carnet/spread valent aussi `null` lorsque leur source facultative est absente ou vide.

## Invariants

1. Aucun réseau, fichier, horloge ou état global mutable à l’exécution.
2. À entrée et paramètres identiques, la sortie est identique.
3. Une série insuffisante, une configuration invalide, une microstructure invalide ou un résultat Prolog non numérique produit un code d’erreur fermé.
4. Aucune valeur transactionnelle ou de carnet n’est inférée depuis OHLCV, et réciproquement.
5. Aucun indicateur n’utilise une chandelle future ; le RVOL exclut explicitement le volume courant de sa référence.
6. L’identifiant du snapshot couvre les bougies, la configuration et le contexte microstructurel fournis.
7. Les règles `.pl` sont la source éditable ; leur représentation TypeScript embarquée est générée et vérifiée.
8. Les prédicats à fenêtre fixe ne reçoivent que leur fenêtre utile ; EMA et ATR de Wilder conservent l’historique requis par leur lissage.
