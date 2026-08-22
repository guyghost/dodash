# Modèle du filtre de régime par pente (EMA_SLOPE)

Extension du modèle `regime-filter.md` : une seconde politique de
classification brute fondée sur la **pente de l'EMA lente** plutôt que sur
l'écart instantané EMA rapide/lente. La machine, les états, l'hystérésis et
les permissions sont inchangés ; seule la source du signal de classification
et la condition de calculabilité changent.

## Motivation (mesuré)

Avec `EMA_THRESHOLD` (100/5/3) sur BTC-USD ONE_DAY 2023-2024, le filtre
termine en `BEARISH` : lors des consolidations haussières, l'écart
emaFast/emaSlow se comprime sous le seuil alors que la tendance de fond
reste intacte. L'ensemble passe de −0,38 % (sans filtre) à −0,17 % (avec
filtre) — amélioration, mais le filtre reste myope. La pente de l'EMA lente
sur `slopePeriods` bougies reste positive à travers ces consolidations :
c'est un signal de tendance plus collant.

## Politique

```ts
type RegimeFilterPolicy =
  | {
      readonly mode: "EMA_THRESHOLD";
      readonly thresholdBps: number;      // séparation EMA minimale pour un régime de tendance
      readonly minObservations: number;
      readonly confirmationCount: number;
    }
  | {
      readonly mode: "EMA_SLOPE";
      readonly slopeThresholdBps: number; // pente minimale (bps) sur slopePeriods pour un régime de tendance
      readonly slopePeriods: number;      // bougies entre les deux points de comparaison de la pente
      readonly minObservations: number;
      readonly confirmationCount: number;
    };
```

Contraintes (les deux modes) : `1 ≤ minObservations`, `1 ≤ confirmationCount`.
`EMA_THRESHOLD` : `0 < thresholdBps < 10 000`. `EMA_SLOPE` :
`0 < slopeThresholdBps < 10 000`, `slopePeriods` entier `≥ 1`. Une politique
invalide produit `INVALID_REGIME_POLICY` et l'acteur termine en `failed`
avant toute observation.

## Classification brute (signal)

L'observation `CANDLE_CLOSED` reste `{ start, emaFast, emaSlow }`, validée
comme en v1 (EMAs finies > 0, timestamps entiers strictement croissants) ;
`emaFast` reste requis par la validation dans les deux modes.

### Mode EMA_THRESHOLD (inchangé)

1. `emaFast > emaSlow × (1 + thresholdBps/10 000)` → `BULLISH` ;
2. `emaFast < emaSlow × (1 − thresholdBps/10 000)` → `BEARISH` ;
3. sinon → `RANGE`.

### Mode EMA_SLOPE

La machine conserve dans son contexte un historique borné
`emaSlowHistory` : les `slopePeriods` dernières valeurs d'`emaSlow`
observées, hors observation courante, de la plus ancienne à la plus récente.
La pente compares l'observation courante à la valeur `slopePeriods` crans
avant :

```text
slopeBps = (emaSlow_courant / emaSlow_référence − 1) × 10 000
avec emaSlow_référence = emaSlowHistory[0]
```

1. `slopeBps > slopeThresholdBps` → `BULLISH` ;
2. `slopeBps < −slopeThresholdBps` → `BEARISH` ;
3. sinon → `RANGE`.

**Pending** : si `emaSlowHistory.length < slopePeriods`, la pente n'est pas
calculable et la classification retourne *pending* (aucun régime brut).
Ce n'est **pas** une erreur : l'observation est valide, elle est comptée et
enregistrée (compteurs et historique mis à jour), mais aucun garde de
régime ne peut satisfaire — l'acteur reste en `warmingUp`. Aucune
transition de régime n'est possible avant que la pente soit calculable ;
le deny-by-default s'applique de fait pendant toute cette phase.

Les inégalités sont strictes : une pente exactement au seuil classe `RANGE`
(parité avec EMA_THRESHOLD).

## Historique borné

- `emaSlowHistory` est appendue à chaque observation valide (y compris
  *pending*), puis tronquée à `slopePeriods` éléments (les plus anciens
  sont évacués).
- En mode `EMA_THRESHOLD`, `slopePeriods` n'existe pas : l'historique reste
  vide et la classification n'en dépend pas.
- L'historique ne contient que des valeurs déjà validées ; aucune
  reclassification rétroactive d'une observation passée n'est possible.

## États et événements

Le graphe est exactement celui de `regime-filter.md` (idle, warmingUp,
regimeBullish/Bearish/Range, stopped, failed). Seule la sémantique de
`warmingUp` s'étend : en mode `EMA_SLOPE`, l'entrée dans un régime exige en
outre que la classification ne soit pas *pending* — ce qui est garanti par
la structure même des gardes (un *pending* ne produit aucune brute, donc
aucune série, donc aucune entrée).

L'historique est appendu par les mêmes actions que les compteurs
(`recordWarmingObservation`, `recordRegimeObservation`, `recordRegimeEntry`)
: une observation valide consommée exactement une fois met à jour compteurs
ET historique, atomiquement.

## Hystérésis, permissions

Inchangés par rapport à `regime-filter.md` : `confirmationCount` brutes
consécutives pour entrer ou changer, une brute conforme remet la série
opposée à zéro, carte de permissions figée (BULLISH : ema-cross, breakout ;
BEARISH/RANGE : rsi-reversion), refus par défaut.

## Invariants (extension)

10. `emaSlowHistory.length ≤ slopePeriods` en tout état (mémoire bornée).
11. Aucune classification en mode `EMA_SLOPE` avant `slopePeriods + 1`
    observations valides (l'acteur est en `warmingUp` ou un régime est déjà
    confirmé — jamais de régime depuis une pente non calculable).
12. La classification ne dépend que de l'observation courante et de
    l'historique borné des observations passées — jamais d'une valeur
    future, jamais d'une entrée non typée.
13. *Pending* n'est pas `failed* : une observation non classifiable ne
    termine jamais l'acteur ; seule une observation invalide le fait.

## Rétro-compatibilité

- `EMA_THRESHOLD` avec les mêmes paramètres produit exactement la
    classification v1 (inégalités, seuils et hystérésis identiques) ;
  les résultats de backtest produits avec la politique plate v1 restent
  reproductibles en passant au mode tagué.
- `regimeFilter` absent → `regimeGating: null` et replay bit-identique
  (IG6 de `backtest-regime-gating.md` inchangé).
- La forme sérialisée de la politique change (champ `mode` ajouté) ; les
  artefacts v1 restent lisibles tels quels, sans réinterprétation.
