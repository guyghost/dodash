# Modèle du moteur d’indicateurs

Le moteur transforme une série OHLCV validée en un instantané déterministe. Les prédicats numériques vivent en Prolog et Tau-Prolog est embarqué comme moteur de calcul, jamais comme service réseau.

## Entrée

- Série de chandelles validée, strictement croissante.
- Paramètres entiers positifs : période RSI, EMA rapide, EMA lente et ATR.
- L’EMA rapide doit être strictement inférieure à l’EMA lente.

## Sortie

`IndicatorSnapshot` contient :

- `rsi`
- `emaFast`
- `emaSlow`
- `macd` (`emaFast - emaSlow`)
- `atr`
- l’instant de la dernière chandelle
- un identifiant déterministe de snapshot

## Sémantique

- RSI utilise les gains/pertes moyens de la fenêtre demandée ; une fenêtre plate vaut `50`, sans perte `100`, sans gain `0`.
- EMA utilise `alpha = 2 / (période + 1)` et la première clôture comme seed.
- ATR utilise la moyenne des true ranges sur la fenêtre demandée.
- MACD est la différence entre les EMA rapide et lente.

## Invariants

1. Aucun réseau, fichier, horloge ou état global mutable à l’exécution.
2. À entrée et paramètres identiques, la sortie est identique.
3. Une série insuffisante ou un résultat Prolog non numérique produit un code d’erreur fermé.
4. Les règles `.pl` sont la source éditable ; leur représentation TypeScript embarquée est générée et vérifiée.

