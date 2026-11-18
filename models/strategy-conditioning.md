# Conditionnement des stratégies par position, ADX, volume relatif et sortie de carry

Statut : normatif (2026-11-15).

## 1. Constat

Les stratégies pures de `@dodash/strategies` (`rsi-reversion`, `breakout`, `funding-trend`) évaluent chaque bougie sans connaissance de la position courante ni des filtres de structure de marché déjà disponibles dans `IndicatorSnapshot` (`trendStrength`, `relativeVolume`) :

1. **Absence de conscience de position (`positionSide`)** :
   - `rsi-reversion` et `breakout` émettent des `BUY` répétés alors que le portefeuille est déjà `LONG`, et des `SELL` alors que le portefeuille est `FLAT` — ce qui génère en spot une majorité de rejets `SPOT_SHORT_FORBIDDEN` (70,6 % mesurés sur les campagnes spot).
2. **Achat en krach directionnel (`rsi-reversion`)** :
   - Un RSI survendu pendant une tendance baissière violente (`trendStrength` élevé, ADX fort) déclenche des entrées `BUY` à contre-tendance.
3. **Breakout sans confirmation de volume (`breakout`)** :
   - Un franchissement de borne `high`/`low` sur faible volume relatif (`relativeVolume` bas ou `null`) produit de faux signaux de cassure.
4. **Absence de sortie sur disparition du carry (`funding-trend`)** :
   - `funding-trend` n'émet qu'à partir de `|fundingAvg| >= enterThreshold` et ne fournit aucun signal de clôture lorsque le carry qui a motivé la position `LONG` ou `SHORT` disparaît ou s'inverse.

## 2. Principes et rétrocompatibilité

- **Rétrocompatibilité stricte** : toutes les nouvelles propriétés de `StrategyContext` et toutes les nouvelles options de configuration sont **optionnelles** et désactivées par défaut (`undefined` / `false`). Sans ces options, le comportement bit-à-bit de chaque stratégie reste inchangé.
- **Pureté et déterminisme** : aucune stratégie ne maintient d'état interne ni n'effectue d'I/O. Les décisions dépendent uniquement de `StrategyContext` et de la configuration immuable.
- **Codes fermés** : chaque blocage ou sortie émet un `reasonCode` fermé explicite.

## 3. Résolution pure et signatures

### 3.1 Extension de `StrategyContext` (`packages/strategies/src/strategy.ts`)

```ts
export type StrategyPositionSide = "FLAT" | "LONG" | "SHORT";
export type StrategyConfirmedRegime = "BULLISH" | "BEARISH" | "RANGE";

export interface StrategyContext {
  readonly productId: ProductId;
  readonly candles: readonly Candle[];
  readonly indicators: IndicatorSnapshot;
  readonly previousIndicators: IndicatorSnapshot | null;
  readonly positionSide?: StrategyPositionSide;
  readonly confirmedRegime?: StrategyConfirmedRegime | null;
}
```

### 3.2 `rsi-reversion` (`packages/strategies/src/rsi-reversion.ts`)

Configuration étendue :
```ts
export interface RsiReversionConfig {
  readonly id?: string;
  readonly oversold: number;
  readonly overbought: number;
  readonly baseSize: number;
  readonly maxTrendStrength?: number;
  readonly positionAware?: boolean;
}
```

Validation de configuration (`INVALID_STRATEGY_CONFIG`) :
- Si `maxTrendStrength !== undefined` : exige `Number.isFinite(maxTrendStrength) && maxTrendStrength > 0`.

Résolution déterministe pour un signal brut `rawSide` (`BUY` si `rsi < oversold`, `SELL` si `rsi > overbought`, sinon `HOLD`) :
1. Si `positionAware === true` :
   - Si `rawSide === "BUY"` et `context.positionSide === "LONG"` → `HOLD` (`suggestedSize: 0`, `confidence: 0`, `reasonCode: "RSI_ALREADY_LONG"`).
   - Si `rawSide === "SELL"` et `context.positionSide === "FLAT"` → `HOLD` (`suggestedSize: 0`, `confidence: 0`, `reasonCode: "RSI_NO_POSITION_TO_SELL"`).
   - Si `rawSide === "SELL"` et `context.positionSide === "SHORT"` → `HOLD` (`suggestedSize: 0`, `confidence: 0`, `reasonCode: "RSI_ALREADY_SHORT"`).
2. Si `maxTrendStrength !== undefined` et `rawSide === "BUY"` et `context.indicators.trendStrength > maxTrendStrength` :
   - → `HOLD` (`suggestedSize: 0`, `confidence: 0`, `reasonCode: "RSI_TREND_BLOCKED"`).
3. Sinon : comportement nominal inchangé (`RSI_OVERSOLD`, `RSI_OVERBOUGHT`, `RSI_NEUTRAL`).

### 3.3 `breakout` (`packages/strategies/src/breakout.ts`)

Configuration étendue :
```ts
export interface BreakoutConfig {
  readonly id?: string;
  readonly lookback: number;
  readonly baseSize: number;
  readonly minRelativeVolume?: number;
  readonly positionAware?: boolean;
}
```

Validation de configuration (`INVALID_STRATEGY_CONFIG`) :
- Si `minRelativeVolume !== undefined` : exige `Number.isFinite(minRelativeVolume) && minRelativeVolume > 0`.

Résolution déterministe pour `rawSide` (`BUY` si `latest.close > highest`, `SELL` si `latest.close < lowest`, sinon `HOLD`) :
1. Si `rawSide === "HOLD"` → `HOLD` (`BREAKOUT_INSIDE_RANGE`, inchangé).
2. Si `positionAware === true` :
   - Si `rawSide === "BUY"` et `context.positionSide === "LONG"` → `HOLD` (`suggestedSize: 0`, `confidence: 0`, `reasonCode: "BREAKOUT_ALREADY_LONG"`).
   - Si `rawSide === "SELL"` et `context.positionSide === "FLAT"` → `HOLD` (`suggestedSize: 0`, `confidence: 0`, `reasonCode: "BREAKOUT_NO_POSITION_TO_SELL"`).
   - Si `rawSide === "SELL"` et `context.positionSide === "SHORT"` → `HOLD` (`suggestedSize: 0`, `confidence: 0`, `reasonCode: "BREAKOUT_ALREADY_SHORT"`).
3. Si `minRelativeVolume !== undefined` :
   - Exige `context.indicators.relativeVolume !== null && Number.isFinite(context.indicators.relativeVolume) && context.indicators.relativeVolume >= minRelativeVolume`.
   - Sinon → `HOLD` (`suggestedSize: 0`, `confidence: 0`, `reasonCode: "BREAKOUT_LOW_VOLUME"`).
4. Sinon : comportement nominal inchangé (`BREAKOUT_UP`, `BREAKOUT_DOWN`).

### 3.4 `funding-trend` (`packages/strategies/src/funding-trend.ts`)

Configuration étendue :
```ts
export interface FundingTrendConfig {
  readonly id?: string;
  readonly enterThreshold?: number;
  readonly exitThreshold?: number;
  readonly baseSize: number;
}
```

Validation de configuration (`INVALID_STRATEGY_CONFIG`) :
- Si `exitThreshold !== undefined` : exige `Number.isFinite(exitThreshold) && exitThreshold >= 0 && exitThreshold < enterThreshold`.

Résolution déterministe après le contrôle de warm-up (`fundingAvg` fini, sinon `FUNDING_WARMUP`) :
1. Si `exitThreshold !== undefined` :
   - Si `context.positionSide === "LONG"` et `fundingAvg > -exitThreshold` → `SELL` (`suggestedSize: config.baseSize`, `confidence: 1`, `reasonCode: "FUNDING_CARRY_EXIT"`).
   - Si `context.positionSide === "SHORT"` et `fundingAvg < exitThreshold` → `BUY` (`suggestedSize: config.baseSize`, `confidence: 1`, `reasonCode: "FUNDING_CARRY_EXIT"`).
2. Sinon : comportement nominal d'entrée inchangé (`FUNDING_LONG_CARRY`, `FUNDING_SHORT_CROWDING`, `FUNDING_NO_SIGNAL`).

### 3.5 `ema-cross` (`packages/strategies/src/ema-cross.ts`) — Amendement 2026-11-18

Configuration étendue :
```ts
export interface EmaCrossConfig {
  readonly id?: string;
  readonly baseSize: number;
  readonly positionAware?: boolean;
}
```

Résolution déterministe pour un signal brut `side` (`BUY` sur `crossedUp`, `SELL` sur `crossedDown`, sinon `HOLD`) :
1. Si `positionAware === true` :
   - Si `side === "BUY"` et `context.positionSide === "LONG"` → `HOLD` (`suggestedSize: 0`, `confidence: 0`, `reasonCode: "EMA_ALREADY_LONG"`).
   - Si `side === "SELL"` et `context.positionSide === "FLAT"` → `HOLD` (`suggestedSize: 0`, `confidence: 0`, `reasonCode: "EMA_NO_POSITION_TO_SELL"`).
   - Si `side === "SELL"` et `context.positionSide === "SHORT"` → `HOLD` (`suggestedSize: 0`, `confidence: 0`, `reasonCode: "EMA_ALREADY_SHORT"`).
2. Sinon : comportement nominal inchangé (`EMA_CROSS_UP`, `EMA_CROSS_DOWN`, `EMA_WARMUP`, `EMA_NO_CROSS`).

## 4. Invariants

1. **INV-SC1 (Rétrocompatibilité)** : sans les nouvelles options et sans `positionSide`/`confirmedRegime`, les signaux produits sont strictement identiques aux versions antérieures.
2. **INV-SC2 (Validation fail-closed)** : `maxTrendStrength <= 0` ou non fini, `minRelativeVolume <= 0` ou non fini, et `exitThreshold < 0` ou `>= enterThreshold` ou non fini retournent `INVALID_STRATEGY_CONFIG`.
3. **INV-SC3 (Priorité position-aware)** : lorsque `positionAware: true` et un filtre indicateur (`maxTrendStrength` ou `minRelativeVolume`) sont tous deux actifs, la garde de position est évaluée avant le filtre indicateur.
4. **INV-SC4 (Sortie de carry bornée)** : `FUNDING_CARRY_EXIT` n'est émis que si `exitThreshold` est configuré, `fundingAvg` est valide (hors warm-up) et `positionSide` est `"LONG"` ou `"SHORT"`.
5. **INV-SC5 (Signal valide)** : tout signal `HOLD` émis suite à un blocage a `suggestedSize === 0` et `confidence === 0`.

## 5. Vérification requise

1. `rsi-reversion` sans nouvelles options → comportement V1 inchangé.
2. `rsi-reversion` avec `maxTrendStrength` invalide (`0`, `-1`, `NaN`) → `INVALID_STRATEGY_CONFIG`.
3. `rsi-reversion` avec `maxTrendStrength` : `BUY` bloqué en `HOLD` (`RSI_TREND_BLOCKED`) quand `trendStrength > maxTrendStrength` ; `BUY` autorisé quand `trendStrength <= maxTrendStrength` ; `SELL` non bloqué par `maxTrendStrength`.
4. `rsi-reversion` avec `positionAware: true` : `BUY` bloqué si `positionSide === "LONG"` (`RSI_ALREADY_LONG`) ; `SELL` bloqué si `positionSide === "FLAT"` (`RSI_NO_POSITION_TO_SELL`) ; `SELL` autorisé si `positionSide === "LONG"` ; `BUY` autorisé si `positionSide === "FLAT"` ou `undefined`.
5. `rsi-reversion` : priorité `RSI_ALREADY_LONG` avant `RSI_TREND_BLOCKED` si `positionSide === "LONG"` et `trendStrength > maxTrendStrength`.
6. `breakout` sans nouvelles options → comportement V1 inchangé.
7. `breakout` avec `minRelativeVolume` invalide (`0`, `-1`, `NaN`) → `INVALID_STRATEGY_CONFIG`.
8. `breakout` avec `minRelativeVolume` : `BUY`/`SELL` bloqué (`BREAKOUT_LOW_VOLUME`) si `relativeVolume === null` ou `< minRelativeVolume` ; autorisé si `relativeVolume >= minRelativeVolume` ; `HOLD` interne inchangé (`BREAKOUT_INSIDE_RANGE`).
9. `breakout` avec `positionAware: true` : `BUY` bloqué si `LONG` (`BREAKOUT_ALREADY_LONG`) ; `SELL` bloqué si `FLAT` (`BREAKOUT_NO_POSITION_TO_SELL`) ; `SELL` autorisé si `LONG`.
10. `funding-trend` avec `exitThreshold` invalide (`-1`, `NaN`, `>= enterThreshold`) → `INVALID_STRATEGY_CONFIG`.
11. `funding-trend` avec `exitThreshold` : `LONG` avec `fundingAvg > -exitThreshold` → `SELL` (`FUNDING_CARRY_EXIT`) ; `SHORT` avec `fundingAvg < exitThreshold` → `BUY` (`FUNDING_CARRY_EXIT`) ; `FLAT` ou `undefined` → pas de sortie de carry ; warm-up (`fundingAvg === undefined`) reste prioritaire (`FUNDING_WARMUP`).
