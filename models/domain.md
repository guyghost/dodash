# Modèle du domaine de trading

Le domaine est un ensemble de valeurs immuables et de constructeurs validants. Il ne connaît ni Cloudflare, ni Coinbase, ni horloge, ni réseau.

## Entités

- `ProductId` : paire Coinbase normalisée `BASE-QUOTE` en majuscules.
- `Timeframe` : ensemble fermé de granularités supportées.
- `Candle` : OHLCV fermé à un instant Unix en millisecondes.
- `Signal` : intention `BUY`, `SELL` ou `HOLD`, confiance bornée et stratégie source.
- `Position` : quantité signée, prix moyen positif et PnL non réalisé.
- `OrderIntent` : ordre déterministe avant effet réseau, identifié par `clientOrderId`.
- `Fill` : exécution observée sur l’exchange, liée à l’ordre client.

## Invariants de marché

1. Un produit contient exactement deux actifs non vides séparés par `-`.
2. Les prix OHLC sont finis et strictement positifs ; le volume est fini et positif ou nul.
3. `high` est supérieur ou égal à `open`, `close` et `low`.
4. `low` est inférieur ou égal à `open`, `close` et `high`.
5. Une série de chandelles est strictement croissante et sans timestamp dupliqué.

## Invariants de décision et d’ordre

1. La confiance d’un signal appartient à `[0, 1]`.
2. `HOLD` n’a jamais de taille suggérée positive.
3. Une intention d’ordre possède une quantité finie strictement positive.
4. Un ordre LIMIT possède un prix limite positif ; un ordre MARKET n’en possède pas.
5. `clientOrderId` est déterministe pour `(agentId, cycleId, decisionId, index)`.
6. Un fill possède prix et quantité strictement positifs, frais positifs ou nuls.

## Frontière numérique

Les calculs internes utilisent des nombres IEEE-754 validés et finis. Avant l’envoi à un exchange, l’adapter d’exécution doit quantifier prix et quantité selon les incréments du produit. Cette quantification est un effet de frontière et ne modifie jamais la décision source.

