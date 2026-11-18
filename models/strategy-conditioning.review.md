# Revue — Conditionnement des stratégies par position, ADX, volume relatif et sortie de carry (2026-11-15)

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**

Modèle revu : `models/strategy-conditioning.md`

## Analyse

- **Pureté et effets** : aucune des extensions n'introduit d'effet de bord, d'I/O ni d'état mutable dans les stratégies. `StrategyContext` reste une interface en lecture seule et toutes les décisions restent des fonctions pures déterministes.
- **Rétrocompatibilité (INV-SC1)** : toutes les nouvelles propriétés de `StrategyContext` (`positionSide`, `confirmedRegime`) et de configuration (`maxTrendStrength`, `positionAware`, `minRelativeVolume`, `exitThreshold`) sont optionnelles et désactivées par défaut. Les stratégies et rejeux existants restent bit-à-bit identiques.
- **Validation fail-closed (INV-SC2)** : les bornes invalides (`<= 0`, `NaN`, `exitThreshold < 0` ou `>= enterThreshold`) produisent explicitement `INVALID_STRATEGY_CONFIG` sans correction silencieuse.
- **Invariants et précédences (INV-SC3, INV-SC4, INV-SC5)** : l'ordre de garde (`positionAware` puis filtre indicateur ; warm-up avant `FUNDING_CARRY_EXIT`) est explicite, déterministe et cohérent avec les contrats de `createSignal` (`HOLD` ⇒ `suggestedSize === 0`).
- **Limites acceptées et impact sur les modèles voisins** : `confirmedRegime` est ajouté sur `StrategyContext` pour permettre aux appelants de fournir le régime confirmé de manière uniforme ; aucune stratégie existante n'est contrainte de l'exploiter dans ce chantier. `scripts/public-exports.json` devra être mis à jour par l'orchestrateur parent si de nouveaux types publics sont exportés depuis `@dodash/strategies`.
- **Amendement 2026-11-18 (`ema-cross` `positionAware`)** : aligne `ema-cross` sur `rsi-reversion` et `breakout` afin d'éviter les rachats pyramidaux en haut de rebond (`EMA_ALREADY_LONG`) et les ventes à vide (`EMA_NO_POSITION_TO_SELL`). Rétrocompatibilité totale lorsque `positionAware` est omis. Verdict : **APPROUVÉ**.
