# Modèle d’exécution du Trading Agent

## Amendement 2026-11-21 — Corrections de sûreté après audit

Le contrat normatif `trading-safety-corrections.md` complète les règles v7 : acteur unique partagé avec les commandes de contrôle, propriétaire d'exécution par créneau, événement `PAPER_PROTECTION_UPDATED` et protection paper persistée, sans modification des seuils v7.

Le Durable Object est un interpréteur de `tradingCycleMachine`. La phase XState
est persistée après chaque événement ; elle seule sélectionne l’effet suivant.

## Projection phase → effet

| Phase machine | Effet autorisé | Événements produits |
| --- | --- | --- |
| `scheduling` | garantir le schedule idempotent | `SCHEDULE_SUCCEEDED`, `SCHEDULE_FAILED` |
| `reconcilingAccount` | lire et valider le portefeuille Coinbase réel avant toute décision live | `ACCOUNT_RECONCILED`, `ACCOUNT_RECONCILIATION_FAILED` |
| `fetchingMarketData` | appeler le service marché interne | `MARKET_DATA_READY`, `MARKET_DATA_FAILED` |
| `computingIndicators` | moteur Prolog pur | `INDICATORS_COMPUTED`, `INDICATORS_FAILED` |
| `evaluatingStrategies` | registre pur | `STRATEGIES_EVALUATED`, `STRATEGIES_FAILED` |
| `allocating` | allocateur pur | `ALLOCATION_COMPLETED`, `ALLOCATION_FAILED` |
| `checkingRisk` | moteur de risque pur | `RISK_APPROVED`, `RISK_REJECTED`, `RISK_FAILED` |
| `persistingOrderIntent` | transaction SQLite de l’intention | `ORDER_INTENT_PERSISTED`, `ORDER_INTENT_FAILED` |
| `authorizing` | autorisation éphémère de l’adapter | `AUTHORIZATION_READY`, `AUTHORIZATION_FAILED` |
| `submittingOrder` | exécution paper ou workflow Coinbase protégé | `ORDER_CONFIRMED`, `ORDER_REJECTED`, `ORDER_NO_LONGER_NEEDED`, `ORDER_OUTCOME_UNKNOWN`, `ORDER_PROTECTION_FAILED` |
| `reconcilingOrder` | résolution idempotente par `clientOrderId`, vérification de la protection et des faits de compte | `ORDER_RECONCILED`, `ORDER_NO_LONGER_NEEDED`, `ORDER_PROTECTION_FAILED`, `RECONCILIATION_FAILED` |
| `cancelling` | stop contrôlé ou kill Coinbase complet suivant `shutdownMode` | `EFFECT_CANCELLED`, `EFFECT_CANCEL_FAILED` |
| `persisting` | transaction SQLite de l’issue | `PERSIST_SUCCEEDED`, `PERSIST_FAILED` |

Les phases `retrying*` ne déclenchent aucun effet immédiatement. Un réveil
ultérieur émet `RETRY_TIMER_ELAPSED`; les compteurs et limites restent dans le
contexte de la machine.

Amendement du 13 octobre 2026 : `MARKET_DATA_READY.evaluatedAt` est lu via
l'horloge injectée après le fetch et son checkpoint, juste avant l'événement.
La garde juge la fraîcheur à cet instant, jamais à l'heure du déclenchement
original d'un cycle repris. Contrat : `market-data-freshness.md`.

Amendement du 13 octobre 2026 : un réveil de grille pendant un cycle reprend
d'abord celui-ci sans `ALARM_FIRED`. Le shell publie son issue et ses alertes,
puis consulte `cycle-wake.md` pour lancer une seule nouvelle invocation si
l'état courant est `waiting`. Son identité est nouvelle ; une alarme ponctuelle
de retry ou une commande de contrôle ne lance jamais cette suite.

## État durable

- L’état synchronisé contient uniquement la configuration validée, la phase et
  le contexte XState, un résumé du dernier cycle, le portefeuille paper, le
  dernier `lastPaperMark` accepté et le dernier snapshot d’indicateurs.
- SQLite contient les cycles, intentions, statuts d’ordre, fills et erreurs.
- L’état XState est persisté avant tout effet pouvant soumettre un ordre.
- Une intention `SUBMITTING` retrouvée au réveil ne peut pas être soumise une
  seconde fois : l’adapter doit réconcilier le `clientOrderId`.
- Un kill demandé pendant une soumission ou une réconciliation résout d'abord
  l'intention en vol, en persiste l'issue, puis exécute le contrôle de compte.
  L'état `halted` exige `killCompleted=true`; le seul drapeau de demande ne
  suffit jamais.
- À la restauration, tout champ de contexte ajouté à une release est normalisé
  vers sa valeur fail-closed explicite avant `resolveState`. Un snapshot legacy
  ne peut laisser ni garde ni identifiant de contrôle dépendre de `undefined`.
- Une restauration de session portefeuille invalide désarme l'agent et
  conserve le book. Elle ne le remplace pas par le capital initial. Contrat :
  `models/paper-book-durability.md` (INV-B1 à INV-B5).
- `EFFECT_CANCEL_FAILED` marque une défaillance terminale puis passe par
  `persisting`. Après `PERSIST_SUCCEEDED`, cette défaillance est prioritaire sur
  stop, kill et scheduling et atteint uniquement `failed`.
- La réponse `/state` (et les réponses de commande qui transportent l'état)
  expose en supplément `portfolioSummary`, projection pure de la hiérarchie
  portefeuille calculée à la lecture et jamais persistée — contrat et
  invariants dans `models/state-portfolio-contract.md` (dao #34). La forme
  mono-produit de la réponse est figée : champs additionnels uniquement.

## Amendement DAO #62 — mark paper et mesure exposée

`lastPaperMark` est une donnée de mesure distincte du portefeuille comptable et
du contexte de la machine. Sa forme est celle de
`PaperValuationMark` (`price`, `source` fermée `*_CANDLE_CLOSE`, `timeframe`,
`candleClosedAt`, `maxMarketStalenessMs`). Le runtime la remplace uniquement après un snapshot marché
accepté, en dérivant `candleClosedAt` depuis le début de bougie et la table
canonique `TIMEFRAME_MILLISECONDS`. Un échec marché conserve le dernier mark
sans en rafraîchir la date. Le mark et sa date sont restaurés ensemble; un état
legacy ou incohérent se normalise vers `null` et produit `unavailable`.
Avant toute persistance, le mark candidat est validé puis copié et gelé par le
modèle `normalizePaperValuationMark`. Un candidat absent ou invalide conserve
uniquement le précédent mark s’il est lui aussi valide; une ancienne valeur
invalide se normalise à `null`. La même règle s’applique aux sessions
multi-produits et à leur restauration; elle ne choisit aucun effet ou
événement XState.

Pour un cycle paper, `accountEquity` de la télémétrie et de l’API est la
projection de `portfolio.cash + portfolio.positionQuantity * mark.price`,
après fill, via `projectPaperValuation`. L’heure de mesure est l’heure de fin
du cycle; la qualité est recalculée sur cette heure et
la politique de péremption capturée avec le mark. Le risque continue à recevoir ses
entrées actuelles dans `RunTradingCycleResult`; le nouveau champ de télémétrie
ne retourne pas vers l’interpréteur ni vers `checkRisk`.

Dans une session multi-produits, `PortfolioProductRuntime` porte un
`lastPaperMark` par produit. Le `portfolioSummary` API projette les valeurs et
expositions depuis ces faits, à un `asOf` fourni, et qualifie l’agrégat. Les
valeurs de l’orchestrateur utilisées par l’admission restent inchangées dans
#62. À la restauration d’un snapshot pré-amendement, les marques manquantes
restent indisponibles; elles ne sont pas reconstruites depuis `averagePrice`.

## Contrôle et permissions

Le Worker authentifie les routes de contrôle avec un secret. Le Durable Object
reçoit ensuite une commande typée et la traduit en événement XState. Les mises à
jour d’état provenant d’une connexion cliente sont rejetées synchroniquement.

Une instance est nommée par une clé stable dérivée de `(produit × stratégies)`.
La configuration n’est modifiable que lorsque la machine est `stopped`.

## Adapter Coinbase live

Le mode `live` n’est activable que si le Worker confirme explicitement
`LIVE_TRADING_ENABLED=true` et dispose, côté serveur, d’une clé CDP ES256 avec
les permissions nécessaires. La configuration, l’état synchronisé et SQLite ne
contiennent jamais la clé privée ni un JWT.

Chaque appel Coinbase reçoit un JWT neuf, signé pour la méthode, l’hôte et le
chemin exacts. Sa durée de vie est au plus de 120 secondes et son nonce est
unique. L'intention persistée utilise `client_order_id` comme clé
d'idempotence. Un BUY est envoyé avec un bracket `trigger_bracket_gtc` attaché
et n'est confirmé qu'après réconciliation de l'ordre parent, de son
`attached_order_id`, de la quantité protégée et des prix arrondis aux incréments
du produit. Un parent terminal avec quantité exécutée nulle est un rejet propre :
aucun `attached_order_id` n'est alors requis.

Avant un SELL directionnel, le workflow `liveSellProtectionMachine` annule et
confirme l'absence des protections connues, relit le compte, vend uniquement la
quantité de l'intention persistée puis relit le résiduel. Un résiduel non nul
reçoit exactement un nouveau bracket confirmé. Une course, une issue inconnue
ou un défaut de protection délègue au kill switch : le résultat normal est
interdit tant que le compte n'est pas plat ou correctement reprotégé.
L'état XState du SELL, le dernier snapshot de compte, la soumission et le plan
protecteur sont checkpointés dans SQLite avant chaque effet. Un réveil reprend
ce checkpoint avec les mêmes identifiants idempotents ; il ne repasse jamais par
la réconciliation générique qui pourrait ignorer la protection résiduelle. Un
échec d'écriture du prochain checkpoint reste une issue inconnue retryable : le
dernier point durable est repris, jamais converti en succès ou échec terminal
qui abandonnerait une position potentiellement non protégée.

Une réponse Coinbase explicite `success=false` ou un HTTP 4xx non ambigu produit
un rejet. Une coupure réseau, un timeout ou un HTTP 5xx après le début d’un POST
produit toujours une issue inconnue. La réconciliation retrouve l'ordre par le
même `client_order_id`, peut rejouer strictement la même requête idempotente si
le protocole l'exige, puis lit son statut avec son `order_id`. Seul un ordre
terminal (`FILLED`, ou terminal sans quantité exécutée) ferme la réconciliation ;
les statuts intermédiaires restent retryables. Pour le kill, un nouvel
identifiant de liquidation n'est permis après recovery qu'après annulation
confirmée des ordres précédents et un nouveau snapshot de compte prouvant le
résiduel.

## Amendement 2026-09-28 — retries planifiés, équité paper, grille et décision manquée

Source : `docs/analysis/analyse-paper-session-2026-09-28.md` ;
modèles `market-retry-schedule.md`, `daily-risk.md`, `cycle-schedule.md`.

1. **Retries marché.** La règle « les phases `retrying*` ne déclenchent aucun
   effet immédiatement » est désormais outillée : en `retryingMarketData`,
   l'interpréteur consulte `artifacts.marketRetry` et `planMarketRetry`,
   persiste l'échéance (checkpoint) avant de programmer une alarme ponctuelle
   `retryTick`, et n'émet `RETRY_TIMER_ELAPSED` qu'à `now ≥ nextRetryAt`. Les
   autres phases `retrying*` gardent leur comportement actuel (réémission au
   même passage) : hors périmètre de cet amendement.
2. **Équité paper du risque journalier.** `resolveCycleDailyRiskStart/Completion`
   paper reçoivent la valorisation `projectPaperValuation` sur le dernier mark
   accepté et délèguent à `resolvePaperDailyRisk` ; l'interpréteur ne ré-ancre
   plus la fenêtre paper sur l'équité de réconciliation au coût.
3. **Planification.** `ensureSchedule` résout `resolveCycleSchedule` : cron
   aligné quand l'intervalle le permet, sinon intervalle ; l'état de
   planification persisté porte `kind` et `expression`.
4. **Décision manquée.** Après chaque cycle terminé, le runtime évalue la règle
   de `cycle-schedule.md §3` et émet `decision.missed` au plus une fois par
   bougie ; `lastMissedDecisionCandleClosedAt` est persisté (mono-produit et par
   produit) et normalisé à `null` à la restauration.

## Amendement 2026-10-10 — politique d'exposition cible P7 (paper)

Source normative : `models/target-exposure.md` (revu). Sous la variante de
sizing `TARGET_EXPOSURE`, la phase `allocating` produit l'ordre à partir de
`planTargetExposure` (au plus une intention MARKET, identifiant de
l'allocateur) au lieu d'`allocateSignals` ; la phase `checkingRisk` applique
`targetExposureRiskGate` (une réduction n'est bloquée ni par la perte
journalière ni par l'admission portefeuille, INV-T7). Aucune phase, aucun
événement ni aucune transition de `trading-cycle.machine.ts` ne change ; la
garde « une décision par bougie » est inchangée.


## Amendement 2026-11-18 — Clôture bornée par position, sortie protectrice Paper (SL/TP) et exécution passive Paper

### 1. Constat

Sur la campagne Paper `ONE_MINUTE` multi-produits (`btc-usd--multi`), trois frictions empêchent la rotation du capital et la réalisation du PnL :
1. `allocateSignals` plafonne les ordres `SELL` par `capitalAvailable` (cash) et non par la quantité réellement détenue (`positionQuantity`), provoquant des rejets `RISK_REJECTED` (`SELL_EXCEEDS_POSITION`) dès qu'un signal de vente dépasse la position ouverte, ou laissant un résidu non nul qui maintient `positionSide === "LONG"`.
2. En mode `paper`, les bornes `stopLossPrice` et `takeProfitPrice` sont calculées mais ne déclenchent aucune clôture automatique lorsque le prix de clôture de la bougie les franchit.
3. En mode `paper` avec `executionStyle === "LIMIT_PASSIVE"`, l'absence de `fetchOrderBook` fait retomber tous les ordres en `MARKET` (frais taker `6 bps` + slippage `2 bps` au lieu de `makerFeeBps: 1` et `0` slippage).

### 2. Résolution pure

1. **Clôture et plafonnement `SELL` sur la position détenue (`@dodash/allocator`)** :
   - `AllocationInput` accepte `positionQuantities?: Readonly<Record<string, number>>` et `closeFullPositionOnSell?: boolean`.
   - Pour un signal net vendeur (`net < 0`), lorsque `positionQuantities[productId]` est fourni :
     - Si `positionQuantities[productId] <= minNetQuantity`, aucun ordre `SELL` n'est alloué.
     - Si `closeFullPositionOnSell === true`, la quantité `SELL` allouée est exactement `positionQuantities[productId]` (clôture intégrale sans poussière résiduelle).
     - Sinon, la quantité `SELL` est bornée par `Math.min(Math.abs(net), positionQuantities[productId])` (sans plafonnement par le cash disponible).
2. **Sortie protectrice automatique en mode Paper (`interpreter.ts`)** :
   - En `executionMode === "paper"`, lorsque `portfolio.positionQuantity > 0` et `portfolio.averagePrice > 0`, les seuils Stop-Loss et Take-Profit effectifs sont résolus à partir de `risk` (`atrStopLossMultiple` / `atrTakeProfitMultiple` avec `indicators.atr`, ou `stopLossBps` / `takeProfitBps`).
   - Si `lastCandle.close <= stopLossPrice` ou `lastCandle.close >= takeProfitPrice`, un signal de sortie prioritaire `SELL` de taille `portfolio.positionQuantity` (`confidence: 1`) est transmis à l'allocateur pour fermer intégralement la position.
3. **Top-of-book synthétique Paper pour `LIMIT_PASSIVE`** :
   - En `executionMode === "paper"` avec `executionStyle === "LIMIT_PASSIVE"`, si aucun carnet externe n'est fourni, le prix `lastCandle.close` forme un `OrderBookTop` synthétique (`bestBid: close, bestAsk: close, spreadBps: 0`), permettant l'émission d'un ordre `LIMIT` passif facturé à `makerFeeBps`.

### 3. Invariants

- **INV-AR1** : Aucun ordre `SELL` alloué avec `positionQuantities` fourni ne peut dépasser `positionQuantities[productId]`.
- **INV-AR2** : Le comportement V1 de `allocateSignals` lorsque `positionQuantities` est omis reste bit-à-bit identique.
- **INV-AR3** : Le mode `live` et le mode `perp` ne sont pas affectés par le carnet synthétique Paper ni par la sortie protectrice Paper.

### 4. Vérification requise

- `allocateSignals` avec `positionQuantities` plafonne un `SELL` trop grand à la position détenue et ferme `100 %` de la position lorsque `closeFullPositionOnSell === true`.
- En cycle `paper`, le franchissement du Take-Profit ou du Stop-Loss sur une position ouverte génère un `ORDER_CONFIRMED` `SELL` liquidant toute la position.
- En cycle `paper` avec `executionStyle: "LIMIT_PASSIVE"` et `makerFeeBps: 1`, l'ordre est exécuté en `LIMIT` avec `1 bps` de frais et `0` slippage.
- En mode `paper` `positionAware`, la distance SL/TP avec ATR respecte un plancher minimal en `bps` (`stopLossBps` / `takeProfitBps`), et un signal `SELL` non protecteur (`BREAKOUT_DOWN`) est ignoré tant que le RSI reste en zone de survente (`rsi < oversold`), éliminant le ping-pong `BUY ↔ SELL` à 1 minute.
- Lorsque `closeFullPositionOnSell === true` et `positionQuantities[productId] > minNetQuantity`, tout signal `BUY` additionnel est ignoré par `allocateSignals` (pas de pyramidage sur position longue déjà ouverte).
- En mode `paper` `positionAware` à l'intérieur du corridor `[stopLossPrice, takeProfitPrice]`, un signal `SELL` non protecteur de stratégie (`EMA_CROSS_DOWN`, `BREAKOUT_DOWN`) n'est exécuté que si le rebond a atteint la zone neutre/haute (`rsi >= 55`) ou si la position est déjà en gain net au-dessus du coût moyen (`close > averagePrice * 1.0005`), évitant la liquidation à 100 % en perte sur micro-croisement EMA.

## Amendement 2026-11-18 (v2) — Exemption de risque sur les ventes de clôture, indexation/purge SQLite, fraîcheur ticker 30s, filtre de régime directionnel (+DI/-DI) et Breakeven / Trailing Stop Paper

### 1. Correctifs de sûreté et de performance

1. **Exemption des ventes réduisant une position longue (`@dodash/risk`)** :
   - Un ordre `SELL` qui réduit ou clôture une position longue existante (`intent.side === "SELL" && currentPositionQuantity > 0 && intent.quantity <= currentPositionQuantity + 1e-12`) réduit le risque d'exposition.
   - Il ne doit jamais être rejeté par `DAILY_LOSS_LIMIT`, `COOLDOWN_ACTIVE`, `ORDER_NOTIONAL_LIMIT`, `POSITION_NOTIONAL_LIMIT` ni `GROSS_EXPOSURE_LIMIT` (seuls `KILL_SWITCH_ACTIVE` et `SPOT_SHORT_FORBIDDEN` s'appliquent).
   - Dans `resolveProtectionDistances`, lorsque l'ATR est actif, les distances `stopDistance` et `takeDistance` respectent `Math.max(rawAtrDistance, bpsDistance)` afin que `stopLossBps` et `takeProfitBps` constituent un plancher minimal cohérent avec l'interpréteur.
2. **Indexation et purge bornée de `dodash_cycles` (`trading-agent.ts`)** :
   - Création idempotente des index `idx_dodash_cycles_triggered_at`, `idx_dodash_cycles_outcome_triggered_at` et `idx_dodash_orders_cycle_id`.
   - Lors de la persistance d'un cycle `NO_ACTION`, purge des lignes `NO_ACTION` au-delà des 400 plus récentes (tous les cycles `ORDER_CONFIRMED`, `RISK_REJECTED` et `FAILED` sont intégralement conservés).
3. **Fraîcheur maximale de 30 secondes sur le cache ticker Coinbase (`coinbase.ts`)** :
   - Lors de la lecture du cache `market:ticker:v1:${productId}`, une entrée dont l'âge `nowSec - cached.observedAt` dépasse `Math.min(cacheTtlSeconds, 30)` est ignorée et rafraîchie en direct, évitant tout rejet `EXECUTION_PRICE_DIVERGENCE` dû à un cache KV de 300s.

### 2. Axe 1 — Filtre de Régime Directionnel (`+DI / -DI / ADX`) & Sizing Adaptatif

En mode `paper` `positionAware`, lorsque `portfolio.positionQuantity === 0` et que les indicateurs directionnels (`plusDi`, `minusDi`, `trendStrength`, `emaFast`, `emaSlow`, `rsi`) sont présents :
- **Régime `BEARISH`** (`minusDi > plusDi * 1.25 && trendStrength >= 22 && emaFast < emaSlow`) :
  - Les signaux `BUY` de suivi de tendance (`ema-cross`, `breakout`) sont filtrés.
  - Les signaux `BUY` de `rsi-reversion` exigent une survente profonde (`rsi <= 22`) et leur `suggestedSize` est réduite de moitié (`× 0.5`).
- **Régime `BULLISH`** (`plusDi > minusDi * 1.25 && trendStrength >= 20 && emaFast >= emaSlow`) :
  - Les signaux `BUY` reçoivent un multiplicateur de taille `× 1.15` (toujours borné par `maxDecisionNotional` et `checkRisk`).
- **Régime `RANGE`** : taille nominale (`× 1.0`).

### 3. Axe 2 — Breakeven Stop & Trailing Stop Dynamique sans état additionnel

En mode `paper` `positionAware`, lorsqu'une position longue est ouverte (`portfolio.positionQuantity > 0 && portfolio.averagePrice > 0`) :
- Le plus haut prix atteint depuis l'entrée (`highWaterMark`) est reconstruit purement à partir des bougies du snapshot postérieures ou égales à `input.lastTradeAt` (`c.start >= input.lastTradeAt`) :
  `highWaterMark = Math.max(portfolio.averagePrice, last.close, ...candlesSinceEntry.map(c => c.high))`
- Soit `peakGainBps = ((highWaterMark - portfolio.averagePrice) / portfolio.averagePrice) * 10_000` :
  - **Palier Breakeven (`peakGainBps >= 22`)** : le Stop-Loss remonte au minimum à `portfolio.averagePrice * 1.0005` (`+5 bps`, couvrant les frais aller-retour).
  - **Palier Trailing Stop (`peakGainBps >= 35`)** : le Stop-Loss suit le plus haut à `Math.max(portfolio.averagePrice * 1.0010, highWaterMark - Math.max(atrVal ?? 0, highWaterMark * 0.0018))`.
- Si `last.close <= effectiveStopLossPrice`, l'interpréteur émet un signal `SELL` prioritaire fermant 100 % de la position (`PAPER_TRAILING_STOP` si `effectiveStopLossPrice > portfolio.averagePrice`, sinon `PAPER_STOP_LOSS`).

## Amendement 2026-11-19 (v3) — Calibration 1m : Régime Baissier, Anti-Revenge-Buying & Asymétrie Gain/Perte

En mode `paper` avec `positionAware === true` :

1. **Calibration 1-minute du filtre `BEARISH` et sizing défensif sous EMA** :
   - Le régime `BEARISH` est actif dès que `minusDi > plusDi * 1.2 && trendStrength >= 15 && emaFast < emaSlow` (seuil ADX abaissé de `22` à `15` pour capturer les glissades régulières en 1-minute). En `BEARISH`, seuls les `BUY` de `rsi-reversion` avec `rsi <= 22` sont conservés, avec `suggestedSize * 0.4`.
   - Hors `BEARISH` et `BULLISH`, si `emaFast < emaSlow` (rebond contre-tendance), tout signal `BUY` voit sa taille réduite à `suggestedSize * 0.4` afin d'éviter l'explosion de notionnel sur les chutes de RSI.
2. **Plancher de cooldown post-clôture (anti-revenge-buying)** :
   - Lorsque `portfolio.positionQuantity === 0` et `input.lastTradeAt !== null`, si `now - input.lastTradeAt < Math.max(risk.cooldownMs, 300_000)` (5 minutes minimum après une clôture), les signaux `BUY` sont filtrés pour empêcher tout rachat à la bougie suivante après un Stop-Loss.
3. **Seuil de sortie anticipée en gain relevé à `+25 bps` / `RSI >= 65`** :
   - À l'intérieur du corridor `[stopLossPrice, takeProfitPrice]`, un signal `SELL` non protecteur est ignoré tant que `rsi < 65` et `last.close <= portfolio.averagePrice * 1.0025` (`+25 bps`), afin que les gagnants atteignent le Breakeven (`+22 bps`), le Trailing Stop (`+35 bps`) ou le Take-Profit (`+55 bps`).

## Amendement 2026-11-19 (v4) — Filtre de Tendance Horaire (`EMA 60`) & Long/Short Symétrique en Paper

Strictement borné à `executionMode === "paper"` avec `positionAware === true` (le mode `live` spot reste `allowShort: false` / `SPOT_SHORT_FORBIDDEN`) :

1. **Support `allowShort?: boolean` (défaut `false`) de bout en bout** :
   - **Stratégies** (`rsi-reversion`, `ema-cross`, `breakout`) : lorsque `allowShort === true`, `FLAT` autorise `BUY` et `SELL` ; `LONG` bloque `BUY` ; `SHORT` bloque `SELL`.
   - **Allocateur** (`allocateSignals`) : en `LONG`, `net < 0` ferme `heldQty` ; en `SHORT` (`heldQty < -minNet`), `net > 0` couvre `Math.abs(heldQty)` sans inversion en un seul ordre ; en `FLAT`, `net > 0` ouvre un `LONG` et `net < 0` ouvre un `SHORT` plafonnés par `remainingNotional / price`.
   - **Risque** (`checkRisk`) : `SPOT_SHORT_FORBIDDEN` est levé uniquement si `config.allowShort === true`. Tout ordre réduisant une position (`SELL` sur `LONG` ou `BUY` sur `SHORT`, `quantity <= |currentPositionQuantity|`) est exempté des limites perte/cooldown/exposition.
   - **Paper Broker** (`executePaperOrder`) : lorsque `config.allowShort === true`, un `SELL` ouvrant un `SHORT` vérifie la marge cash (`notional + fee <= portfolio.cash + cashTolerance`) et applique la comptabilité short (`positionQuantity < 0`, `realizedPnl` au rachat `BUY` = `(averagePrice - price) * closedQuantity - fee`).
2. **Filtre de tendance horaire (`EMA 60` sur les 200 bougies `1m`)** :
   - Calculé purement sur `candles.map(c => c.close)` dès que `candles.length >= 60`.
   - **Tendance horaire haussière (`last.close >= ema60`)** : `BUY` autorisé (`1,15×` en `BULLISH`, `1,0×` neutre, `0,4×` si `emaFast < emaSlow`) ; ouverture `SELL` (short) bloquée sauf `rsi-reversion` avec `rsi >= 80` (`0,4×`).
   - **Tendance horaire baissière (`last.close < ema60`)** : ouverture `SELL` (short) autorisée (`1,15×` en `BEARISH`, `1,0×` neutre, `0,4×` si `emaFast > emaSlow`) ; ouverture `BUY` (long) bloquée sauf `rsi-reversion` avec `rsi <= 20` (`0,4×`).
3. **Protection & Breakeven / Trailing Stop symétrique sur `SHORT` (`positionQuantity < 0`)** :
   - `baseStopLossPrice = averagePrice + stopDistance`, `takeProfitPrice = averagePrice - takeDistance`.
   - `lowWaterMark = Math.min(averagePrice, last.close, ...candlesSinceEntry.map(c => c.low))`, `peakGainBps = ((averagePrice - lowWaterMark) / averagePrice) * 10_000`.
   - Breakeven (`peakGainBps >= 22`) → `stopLossPrice <= averagePrice * 0.9995` ; Trailing (`peakGainBps >= 35`) → `stopLossPrice <= Math.min(averagePrice * 0.999, lowWaterMark + Math.max(atr, lowWaterMark * 0.0018))`.
   - Hors SL/TP, un `BUY` stratégie non protecteur est ignoré tant que `rsi > 35` et `last.close >= averagePrice * 0.9975` (`< +25 bps`).
4. **Projection `/pnl` & Dashboard** :
   - `models/dashboard-pnl-history.ts` et `apps/dashboard/src/dashboard-api.ts` acceptent `positionQuantity` signé (`< 0` pour `SHORT`) avec `grossExposure = |positionQuantity| * markPrice`.

## Amendement 2026-11-20 (v5) — Calibration Wide Trailing (`V5B`) validée par backtest `5m`

Suite à l'étude d'ablation sur 5 jours réels Hyperliquid (`5m`, 1 441 bougies/paire), le Breakeven (`+22 bps`) et le Trailing Stop (`+35 bps` / recul `18 bps`) s'avéraient trop serrés (coupure prématurée de `117` trades gagnants). Ils sont remplacés par le **Wide Trailing symétrique (`V5B`)** :

- **LONG (`positionQuantity > 0`)** : le plancher dynamique ne s'active qu'à partir de `peakGainBps >= 75` à `Math.max(portfolio.averagePrice * 1.001, highWaterMark - Math.max(useAtr ? atrVal * 1.5 : 0, highWaterMark * 0.004))`. En deçà de `+75 bps`, `baseStopLossPrice` reste inchangé pour laisser le trade atteindre le Take-Profit.
- **SHORT (`positionQuantity < 0`)** : le plafond dynamique ne s'active qu'à partir de `peakGainBps >= 75` à `Math.min(portfolio.averagePrice * 0.999, lowWaterMark + Math.max(useAtr ? atrVal * 1.5 : 0, lowWaterMark * 0.004))`.

## Amendement 2026-11-21 (v6) — Garde anti-micro-sortie en frais (`RSI 75/25` + plancher net `+5 bps`)

À l'intérieur du corridor `[stopLossPrice, takeProfitPrice]`, une sortie anticipée sur signal stratégie non protecteur n'est autorisée que si elle dégage un gain net suffisant :
- **LONG** : autorisée uniquement si `last.close > averagePrice * 1.0025` (`+25 bps`) **ou** (`rsi >= 75 && last.close > averagePrice * 1.0005`), éliminant les sorties à l'équilibre qui paient uniquement les frais.
- **SHORT** : autorisée uniquement si `last.close < averagePrice * 0.9975` (`+25 bps`) **ou** (`rsi <= 25 && last.close < averagePrice * 0.9995`).

## Amendement 2026-11-21 (v7) — Stop-Loss Paper `MARKET`, filtre de tendance multi-horizon (`EMA 180`/`EMA 60`), suppression du contre-tendance `0,4×`, seuils `5m` et symétrie comptable `SHORT`

### 1. Constat (campagne V5B `2026-11-20 10:15 → 2026-11-21 09:30 UTC`, `N = 231` AR vérifiés)

1. **Coût irréaliste des Stop-Loss paper** : en mode `LIMIT_PASSIVE`, les 80 sorties `PAPER_STOP_LOSS` étaient exécutées au `close` en `LIMIT` (`1 bps` maker, `0` slippage) via le carnet synthétique, alors qu'un stop d'urgence réel s'exécute en `MARKET` (`feeBps + slippageBps`).
2. **Entrées contre-tendance perdantes** : sur une baisse de `-6,23 %`, `EMA 60` sur bougies `1m` (demi-vie ~20 min) a laissé passer 91 `LONG` (`-$30,54`, `PF 0,66`) contre 140 `SHORT` (`+$54,77`, `PF 1,45`) ; les entrées contre-tendance `0,4×` (`< 300 $`) affichent `WR 42,4 %` et `-9,0 bps/AR`.
3. **Calibration `5m` & alignement Wide Trailing (`+75 bps`)** : avec `takeProfitBps = 55` en `1m`, le Take-Profit fermait avant l'activation du Wide Trailing (`+75 bps`). Sur `FIVE_MINUTE` (où `takeProfitBps` vise `120–150 bps`), le seuil de sortie anticipée sur signal stratégie (`+25 bps` / `+5 bps` RSI) reste trop bas face à l'ATR `5m`.
4. **Asymétrie comptable `SHORT`** : dans `executePaperOrder` (`packages/paper-execution/src/index.ts`), `averagePrice` incluait les frais d'entrée sur `LONG` (`+fee`) mais pas sur `SHORT` (`0`), surestimant `realizedPnl` sur chaque clôture `SHORT` du montant des frais d'entrée par rapport au delta de cash réel.

### 2. Résolution pure

1. **Exécution `MARKET` sur `PAPER_STOP_LOSS` (`interpreter.ts`)** :
   - Lorsqu'un signal protecteur de sortie émis en `paper` porte `reasonCode === "PAPER_STOP_LOSS"`, l'appel à `allocateSignals` force `executionStyle: "MARKET"` et omet `orderBooks` (aucun carnet synthétique), afin que `executePaperOrder` applique `feeBps` (taker) et `slippageBps`.
   - `PAPER_TAKE_PROFIT`, `PAPER_TRAILING_STOP`, les ouvertures et les sorties stratégie conservent `input.configuration.executionStyle`.
2. **Filtre de tendance multi-horizon et blocage strict du contre-tendance (`interpreter.ts`)** :
   - Période `trendEmaPeriod = input.configuration.timeframe === "ONE_MINUTE" ? 180 : 60` (3 h en `1m`, 5 h en `5m`), calculée sur `candles.map(c => c.close)` dès que `candles.length >= trendEmaPeriod`.
   - Tendance baissière (`last.close < trendEma`) : toute ouverture `BUY` est bloquée (`null`), y compris `rsi-reversion`.
   - Tendance haussière (`last.close >= trendEma`) : toute ouverture `SELL` est bloquée (`null`), y compris `rsi-reversion`.
   - Contre-régime directionnel (`isBearishRegime` pour `BUY`, `isBullishRegime` pour `SELL`) : bloqué (`null`), supprimant les entrées `0,4×` en rattrapage de couteau.
3. **Seuils de sortie anticipée adaptés au timeframe (`interpreter.ts`)** :
   - En `ONE_MINUTE` : inchangés (`+25 bps` ou `RSI >= 75 / <= 25` avec gain net `> +5 bps`).
   - En `timeframe !== "ONE_MINUTE"` (ex. `FIVE_MINUTE`) : sortie stratégie non protectrice autorisée uniquement si le gain dépasse `+45 bps` (`1.0045` / `0.9955`) **ou** (`RSI >= 75 / <= 25` et gain net `> +15 bps`, soit `1.0015` / `0.9985`).
4. **Symétrie comptable `SHORT` (`packages/paper-execution/src/index.ts`)** :
   - Lors de l'ouverture ou de l'augmentation d'un `SHORT` (`sameDirection && intent.side === "SELL"`), `averagePrice = (|current| * portfolio.averagePrice + |delta| * price - fee) / |nextQuantity|` (base nette encaissée après frais d'entrée), à condition que le numérateur soit strictement positif (garanti par `feeBps < 10_000`).

### 3. Invariants additionnels

- **INV-AR4** : En mode `paper`, un `PAPER_STOP_LOSS` produit toujours un `OrderIntent` de type `MARKET` (`limitPrice === null`), même lorsque `executionStyle === "LIMIT_PASSIVE"`.
- **INV-AR5** : Aucune ouverture `BUY` n'est émise lorsque `last.close < trendEma` (avec `trendEmaPeriod = 180` en `1m`, `60` sinon), et aucune ouverture `SELL` lorsque `last.close >= trendEma`.
- **INV-AR6** : Sur un cycle complet ouverture + clôture intégrale en `executePaperOrder` (LONG ou SHORT, sans flux externe), `realizedPnl === cashFinal - cashInitial` à la précision flottante près.
- **INV-AR7** : Les modes `live` et `perp` ne sont pas affectés par ces règles `paper`.

### 4. Vérification requise

- `executePaperOrder` sur `SHORT` : `averagePrice` intègre les frais d'entrée (`price - fee / qty`) et `realizedPnl` à la clôture égale exactement `cashFinal - cashInitial`.
- `runTradingCycle` en `paper` + `LIMIT_PASSIVE` + `positionAware` : un `PAPER_STOP_LOSS` émet un ordre `MARKET` (`limitPrice: null`, frais `feeBps` + `slippageBps`), tandis qu'un `PAPER_TAKE_PROFIT` reste en `LIMIT` (`makerFeeBps`, `0` slippage).
- `runTradingCycle` en `paper` + `positionAware` : aucune ouverture `BUY` contre-tendance sous `trendEma` même avec `RSI <= 20` ; en `FIVE_MINUTE`, une sortie stratégie à `+30 bps` (sous `+45 bps` et `RSI < 75`) est filtrée.
