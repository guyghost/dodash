# Revue — Risque dynamique ATR et Exécution LIMIT Post-Only (2026-11-15)

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**

## Analyse critique

- **Pureté et absence d'effets de bord** : les deux évolutions restent strictement confinées aux fonctions pures `checkRisk` (`@dodash/risk`) et `allocateSignals` (`@dodash/allocator`). Aucun I/O, aucune horloge implicite, aucune dépendance réseau ni modification des machines XState.
- **Rétrocompatibilité** : tous les nouveaux champs (`atr`, `atrStopLossMultiple`, `atrTakeProfitMultiple`, `executionStyle`, `orderBooks`, `maxSpreadBps`) sont optionnels. En leur absence (ou lorsque le jeu de paramètres ATR est incomplet), le comportement V1 est préservé à l'identique.
- **Invariants et validation fail-closed** :
  - Les entrées invalides (`<= 0` ou non finies pour ATR/multiples, `< 0` ou non finies pour `maxSpreadBps`, style inconnu) sont rejetées via les codes d'erreur fermés existants (`INVALID_RISK_CONFIG`, `INVALID_RISK_SNAPSHOT`, `INVALID_ALLOCATION_CONFIG`).
  - Le bornage des distances ATR (`0.9999` pour SL, `9.9999` pour TP) est aligné sur les bornes V1 (`stopLossBps < 10_000`, `takeProfitBps < 100_000`) et empêche tout `stopLossPrice <= 0` sur un achat.
  - La validation du carnet (`bestBid > 0`, `bestAsk >= bestBid`, finis) garantit que `createOrderIntent` reçoit toujours un `limitPrice` strictement positif et fini pour `type: "LIMIT"`.
- **Choix de repli et limites acceptées** :
  - Lorsque `executionStyle === "LIMIT_PASSIVE"` mais que le carnet L1 est absent ou invalide pour `productKey`, le repli explicite sur `MARKET` (`limitPrice: null`) évite un blocage silencieux de l'exécution tout en restant documenté et testable.
  - La garde de spread (`maxSpreadBps`) ne s'applique que si un carnet est présent pour `productKey` ; si `spreadBps > maxSpreadBps` (ou non fini / négatif), le produit est ignoré sans consommer `remainingNotional`.
  - Le dimensionnement (`quantity`) reste calculé sur `marketPrices[productKey]` afin de ne pas coupler la taille de position au spread L1.
- **Impact sur les modèles voisins** : `packages/domain/src/trading.ts` supporte déjà nativement `type: "LIMIT"` et `limitPrice` dans `OrderIntent` et `createOrderIntent`. Aucun changement de domaine ni de contrat XState n'est requis.

## Revue de l'amendement du 2026-11-15 — Exécution effective LIMIT Post-Only et Câblage Configuration

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**

- **Adaptateurs d'exécution** :
  - `@dodash/paper-execution` : `LIMIT` rempli au `limitPrice` sans slippage avec `makerFeeBps ?? feeBps` ; toute configuration hors domaine (`makerFeeBps < 0` ou `>= 10_000`) échoue fail-closed.
  - Coinbase : `limit_limit_gtc` + `post_only: true` utilise `quote_increment` du produit avec arrondi conservateur (`DOWN` à l'achat, `UP` à la vente) pour garantir la passivité et éviter les rejets tick/post-only ; aucun appel réseau additionnel sur les ordres `MARKET`.
  - Hyperliquid : `tif: "Alo"` activé uniquement lorsque `PerpOrderIntent.limitPrice` est présent et validé `> 0` et fini par `isWellFormedPerpIntent`. `hyperliquidMarketIocOrder` et les ordres `MARKET` existants restent inchangés.
- **Configuration et interpréteur** :
  - Toutes les options ajoutées à `AgentConfiguration` (`strategyOptions`, `executionStyle`, `maxSpreadBps`, `broker.makerFeeBps`, `sizingPolicy.costAwareRebalance`) sont optionnelles et omises si absentes (`exactOptionalPropertyTypes`), garantissant zéro régression sur la sérialisation V1 et les tests existants.
  - Le repli sur `MARKET` sans `fetchOrderBook` préserve la continuité d'exécution.
