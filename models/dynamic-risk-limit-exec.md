# Risque dynamique indexé sur l'ATR et Exécution LIMIT Post-Only guidée par la Microstructure

Statut : normatif (2026-11-15).

## Constat

1. **Protections statiques dans `@dodash/risk`** : `checkRisk` calcule actuellement `stopLossPrice` et `takeProfitPrice` à partir de distances fixes en points de base (`stopLossBps / 10_000` et `takeProfitBps / 10_000`). En régime de forte volatilité, un stop fixe est déclenché prématurément par le bruit de marché ; en régime calme, il laisse courir une perte excessive par rapport à l'amplitude réelle des bougies.
2. **Exécution `MARKET` systématique dans `@dodash/allocator`** : `allocateSignals` émet exclusivement des ordres `type: "MARKET"` avec `limitPrice: null`, sans tenir compte de la microstructure L1 (spread bid-ask, meilleur bid, meilleur ask). Sur des carnets peu liquides ou temporairement écartés, les ordres au marché subissent le coût du spread et le slippage, alors qu'un placement passif au meilleur prix du côté passif (`bestBid` à l'achat, `bestAsk` à la vente) réduit les frais taker et évite de traverser un spread anormalement large.
3. **Contrainte de rétrocompatibilité** : les appelants existants (runtime et backtest) qui ne fournissent pas d'ATR ni de carnets L1 doivent conserver exactement le comportement V1.

## Résolution pure

### 1. Risque dynamique ATR (`@dodash/risk`)

Extension rétrocompatible des contrats de `packages/risk/src/risk.ts` :

```ts
export interface RiskConfig {
  // ... champs V1 inchangés ...
  readonly atrStopLossMultiple?: number;
  readonly atrTakeProfitMultiple?: number;
}

export interface RiskSnapshot {
  // ... champs V1 inchangés ...
  readonly atr?: number;
}
```

Validation fail-closed :
- Si `config.atrStopLossMultiple !== undefined`, il doit être fini et strictement positif (`> 0`), sinon `err({ code: "INVALID_RISK_CONFIG" })`.
- Si `config.atrTakeProfitMultiple !== undefined`, il doit être fini et strictement positif (`> 0`), sinon `err({ code: "INVALID_RISK_CONFIG" })`.
- Si `snapshot.atr !== undefined`, il doit être fini et strictement positif (`> 0`), sinon `err({ code: "INVALID_RISK_SNAPSHOT" })`.

Calcul pur des distances relatives :
- Constantes de bornage : `MAX_ATR_STOP_DISTANCE = 0.9999`, `MAX_ATR_TAKE_DISTANCE = 9.9999`.
- Si `snapshot.atr !== undefined && config.atrStopLossMultiple !== undefined && config.atrTakeProfitMultiple !== undefined` :
  - `stopDistance = Math.min((snapshot.atr * config.atrStopLossMultiple) / snapshot.marketPrice, MAX_ATR_STOP_DISTANCE)`
  - `takeDistance = Math.min((snapshot.atr * config.atrTakeProfitMultiple) / snapshot.marketPrice, MAX_ATR_TAKE_DISTANCE)`
- Sinon (un ou plusieurs des trois paramètres absents) :
  - Comportement V1 inchangé : `stopDistance = config.stopLossBps / 10_000`, `takeDistance = config.takeProfitBps / 10_000`.
- Calcul des prix de protection inchangé à partir de `stopDistance` et `takeDistance` :
  - `BUY` : `stopLossPrice = marketPrice * (1 - stopDistance)`, `takeProfitPrice = marketPrice * (1 + takeDistance)`
  - `SELL` : `stopLossPrice = marketPrice * (1 + stopDistance)`, `takeProfitPrice = marketPrice * (1 - takeDistance)`

### 2. Exécution `LIMIT` guidée par la Microstructure (`@dodash/allocator`)

Extension rétrocompatible des contrats de `packages/allocator/src/allocator.ts` :

```ts
export type ExecutionStyle = "MARKET" | "LIMIT_PASSIVE";

export interface OrderBookTop {
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly spreadBps: number;
}

export interface AllocationInput {
  // ... champs V1 inchangés ...
  readonly executionStyle?: ExecutionStyle;
  readonly orderBooks?: Readonly<Record<string, OrderBookTop>>;
  readonly maxSpreadBps?: number;
}
```

Validation fail-closed de la configuration :
- Si `input.executionStyle !== undefined`, il doit valoir `"MARKET"` ou `"LIMIT_PASSIVE"`, sinon `err({ code: "INVALID_ALLOCATION_CONFIG" })`.
- Si `input.maxSpreadBps !== undefined`, il doit être fini et `>= 0`, sinon `err({ code: "INVALID_ALLOCATION_CONFIG" })`.

Décision par produit `productKey` (après calcul de `netQuantities[productKey]` et vérification de `minNetQuantity` / `remainingNotional`) :
1. **Garde de spread (fail-closed)** :
   - Soit `book = input.orderBooks?.[productKey]`.
   - Si `input.maxSpreadBps !== undefined` et `book !== undefined`, et que `!Number.isFinite(book.spreadBps) || book.spreadBps < 0 || book.spreadBps > input.maxSpreadBps`, aucun ordre n'est émis pour `productKey` (skip, `remainingNotional` non consommé, index d'ordre non incrémenté).
   - Si `book === undefined`, la garde de spread ne bloque pas (absence de carnet L1).
2. **Sélection du style d'exécution** :
   - Un carnet `book` est valide pour le placement passif ssi `Number.isFinite(book.bestBid) && book.bestBid > 0 && Number.isFinite(book.bestAsk) && book.bestAsk >= book.bestBid`.
   - Si `input.executionStyle === "LIMIT_PASSIVE"` et que `book` est présent et valide :
     - `type = "LIMIT"`
     - `limitPrice = side === "BUY" ? book.bestBid : book.bestAsk`
   - Sinon (y compris si `executionStyle === "LIMIT_PASSIVE"` sans carnet valide — repli explicite sur `MARKET` pour préserver la continuité d'exécution) :
     - `type = "MARKET"`
     - `limitPrice = null`
3. **Dimensionnement** : la quantité et la déduction sur `remainingNotional` restent indexées sur `input.marketPrices[productKey]`.

## Décisions d'état

Aucune nouvelle machine XState ni modification des transitions d'état du cycle de trading : ces deux évolutions opèrent exclusivement dans le cœur fonctionnel pur (`@dodash/risk` et `@dodash/allocator`). Aucun effet de bord ni appel réseau.

## Invariants

1. **Rétrocompatibilité stricte** : sans les champs optionnels (`atr`, `atrStopLossMultiple`, `atrTakeProfitMultiple`, `executionStyle`, `orderBooks`, `maxSpreadBps`), `checkRisk` et `allocateSignals` produisent des sorties bit-à-bit identiques à la V1.
2. **Fail-closed sur entrées invalides** : tout paramètre optionnel fourni avec une valeur non finie ou hors domaine (`<= 0` pour ATR/multiples, `< 0` pour `maxSpreadBps`, valeur inconnue pour `executionStyle`) retourne immédiatement une erreur typée fermée (`INVALID_RISK_CONFIG`, `INVALID_RISK_SNAPSHOT`, `INVALID_ALLOCATION_CONFIG`).
3. **Bornage des distances ATR** : `stopDistance <= 0.9999` garantit `stopLossPrice > 0` pour un ordre `BUY` ; `takeDistance <= 9.9999` borne l'écart relatif de prise de profit dans la même plage que la V1 (`takeProfitBps < 100_000`).
4. **Intégrité `OrderIntent`** : tout ordre `LIMIT` émis satisfait `limitPrice !== null && Number.isFinite(limitPrice) && limitPrice > 0` (garanti par `bestBid > 0` et `bestAsk >= bestBid`), et tout ordre `MARKET` satisfait `limitPrice === null`.
5. **Non-consommation du budget sur skip** : un produit ignoré par la garde de spread (`spreadBps > maxSpreadBps`) ne consomme pas `remainingNotional` et ne décale pas la séquence `clientOrderId` des produits suivants.

## Vérification requise

### `@dodash/risk` (`packages/risk/test/risk.test.ts`)
1. Rétrocompatibilité V1 : sans `atr` ni multiples, `stopLossPrice` et `takeProfitPrice` utilisent `stopLossBps` / `takeProfitBps`.
2. Rétrocompatibilité partielle : si `atr` est fourni sans les deux multiples (ou inversement), repli sur `stopLossBps` / `takeProfitBps`.
3. Calcul dynamique ATR pour `BUY` : `atr`, `atrStopLossMultiple` et `atrTakeProfitMultiple` calculent les prix attendus.
4. Calcul dynamique ATR pour `SELL` : symétrie des signes (`marketPrice * (1 + stopDistance)` et `marketPrice * (1 - takeDistance)`).
5. Bornage ATR : un ATR extrême borne `stopDistance` à `0.9999` (soit `stopLossPrice > 0` sur `BUY`) et `takeDistance` à `9.9999`.
6. Validation fail-closed : `atr <= 0` ou `NaN` retourne `INVALID_RISK_SNAPSHOT` ; `atrStopLossMultiple <= 0` ou `atrTakeProfitMultiple <= 0` ou `NaN` retourne `INVALID_RISK_CONFIG`.

### `@dodash/allocator` (`packages/allocator/test/allocator.test.ts`)
7. Rétrocompatibilité V1 : par défaut (`executionStyle` omis ou `"MARKET"`), les ordres émis sont `type: "MARKET"` et `limitPrice: null`.
8. `LIMIT_PASSIVE` sur `BUY` avec carnet valide : émet `type: "LIMIT"` et `limitPrice === bestBid`.
9. `LIMIT_PASSIVE` sur `SELL` avec carnet valide : émet `type: "LIMIT"` et `limitPrice === bestAsk`.
10. `LIMIT_PASSIVE` sans carnet valide (carnet absent ou `bestBid <= 0` ou `bestAsk < bestBid`) : repli explicite sur `type: "MARKET"` et `limitPrice: null`.
11. Garde de spread (`maxSpreadBps`) : si `spreadBps > maxSpreadBps`, le produit est ignoré (`NO_ACTION` si seul produit, ou autres produits alloués avec `clientOrderId` contigu et `remainingNotional` préservé).
12. Validation fail-closed : `maxSpreadBps < 0` ou `NaN` retourne `INVALID_ALLOCATION_CONFIG`.

## Amendement 2026-11-15 — Exécution effective `LIMIT` Post-Only et exposition `AgentConfiguration`

Statut : normatif (2026-11-15).

### 1. Exécution effective dans les adaptateurs

1. **Paper broker (`@dodash/paper-execution`)** :
   - `PaperBrokerConfig` accepte un champ optionnel `makerFeeBps?: number` (`0 <= makerFeeBps < 10_000`, fini). En son absence, `feeBps` est utilisé pour tous les ordres (rétrocompatibilité stricte).
   - Lorsque `intent.type === "LIMIT"` et `intent.limitPrice !== null` (`> 0` fini) :
     - Le prix d'exécution effectif vaut exactement `intent.limitPrice` (zéro slippage, exécution passive).
     - Les frais sont calculés au taux `makerFeeBps ?? feeBps`.
   - Lorsque `intent.type === "MARKET"`, le comportement V1 reste inchangé (`slippageBps`, `feeBps`).
2. **Coinbase Live (`apps/agent/src/coinbase-execution.ts`)** :
   - Lorsque `intent.type === "LIMIT"` :
     - `intent.limitPrice` doit être strictement positif et fini (sinon refus `ORDER_REJECTED`).
     - `limit_price` est arrondi au `quote_increment` du produit Coinbase (vers le bas pour `BUY`, vers le haut pour `SELL` afin de ne pas traverser le carnet).
     - La requête `POST /api/v3/brokerage/orders` émet `order_configuration.limit_limit_gtc: { base_size, limit_price, post_only: true }`.
     - Pour `intent.type === "MARKET"`, la requête `market_market_ioc` V1 reste strictement inchangée.
3. **Hyperliquid Perp (`models/hyperliquid-execution.types.ts`, `models/hyperliquid-execution.ts`, `apps/agent/src/hyperliquid-execution.ts`, `apps/agent/src/hyperliquid-control.ts`)** :
   - `PerpOrderIntent` accepte `limitPrice?: number`. `isWellFormedPerpIntent` rejette tout `limitPrice` défini non fini ou `<= 0`.
   - Lorsque `intent.limitPrice !== undefined`, la construction d'ordre Hyperliquid émet le prix formaté (5 chiffres significatifs) avec `{ limit: { tif: "Alo" } }` (Add Liquidity Only — post-only natif).
   - Sans `limitPrice`, `hyperliquidMarketIocOrder` (`tif: "Ioc"`, `aggressivePrice`) reste inchangé.
   - `toPerpIntent` transmet `limitPrice` quand `intent.type === "LIMIT"` (et rejette si `limitPrice` invalide).

### 2. Exposition dans `AgentConfiguration`, registre et interpréteur

Champs optionnels rétrocompatibles dans `AgentConfiguration` (`apps/agent/src/configuration.ts`) :
- `strategyOptions?: { positionAware?: boolean; maxTrendStrength?: number; minRelativeVolume?: number; exitThreshold?: number }` :
  - Transmis dans `createConfiguredStrategyRegistry` uniquement aux stratégies concernées (`rsi-reversion`: `positionAware`, `maxTrendStrength`; `breakout`: `positionAware`, `minRelativeVolume`; `funding-trend`: `exitThreshold` avec `0 <= exitThreshold < FUNDING_TREND_ENTER_THRESHOLD`).
- `executionStyle?: ExecutionStyle` (`"MARKET" | "LIMIT_PASSIVE"`) et `maxSpreadBps?: number` (`>= 0`, fini) :
  - Transmis par l'interpréteur (`allocating`) à `allocateSignals`.
  - Un effet optionnel `effects.fetchOrderBook?(configuration)` (`Promise<OrderBookTop | null>`) fournit le carnet L1 du produit quand configuré (`l2Book` Hyperliquid en mode `perp` pour `LIMIT_PASSIVE` ou `maxSpreadBps !== undefined`). En son absence, `allocateSignals` applique son repli normatif sur `MARKET` sans erreur.
- `sizingPolicy` variante `TARGET_EXPOSURE` : champs optionnels `costAwareRebalance?: boolean`, `costMultiple?: number`, `minCostEdgeMultiple?: number`, transmis par `targetExposureAllocation` à `planTargetExposure`.

### Vérification requise (amendement)

- `@dodash/paper-execution` : `LIMIT` exécuté à `limitPrice` sans slippage et avec `makerFeeBps`, validation fail-closed d'un `makerFeeBps` négatif ou `>= 10_000`.
- `coinbase-execution` : `LIMIT` émet `limit_limit_gtc` avec `post_only: true` et `limit_price` arrondi à `quote_increment` (`DOWN` sur `BUY`, `UP` sur `SELL`), `MARKET` inchangé.
- `hyperliquid-execution` / `hyperliquid-control` : `PerpOrderIntent` avec `limitPrice` signe une action `tif: "Alo"` ; `toPerpIntent` refuse un `LIMIT` sans `limitPrice > 0`.
- `configuration` / `strategy-registry` / `interpreter` : les options absentes préservent la forme exacte V1 (`exactOptionalPropertyTypes`) ; activées, elles atteignent les stratégies, `allocateSignals` (`LIMIT_PASSIVE` + `maxSpreadBps` + `fetchOrderBook`), et `planTargetExposure` (`costAwareRebalance`).
