# Modèle signaux perp (proxy Coinbase)

Les instances perp exécutent les perpétuels Hyperliquid à partir des
bougies **spot Coinbase** du marché miroir : l'infrastructure marché,
les indicateurs, les stratégies, l'allocation et le cœur de risque du
cycle existant sont réutilisés tels quels — `tradingCycleMachine` reste
l'orchestrateur, et la venue est une couture d'effets, pas une seconde
boucle métier.

## Choix de source (décision opérateur, option A)

| Signal (produit configuré) | Exécuté sur | Coin Hyperliquid |
| --- | --- | --- |
| `BTC-USD` | `BTC-PERP` | `BTC` |
| `ETH-USD` | `ETH-PERP` | `ETH` |

La correlation spot/perp sur BTC et ETH rend le proxy fidèle ; la
cohérence stricte signal/exécution (bougies Hyperliquid) reste une
évolution possible, non modélisée ici.

## Mode `perp`

`executionMode: "perp"` est un troisième mode d'instance, live par
définition : il n'existe pas de perp simulé, le mode paper reste spot.
Ses défauts sont forcés par l'enveloppe `HYPERLIQUID_PERP_2026_08`
(timeframe `ONE_DAY`, intervalle horaire, risque = enveloppe, décision
max 600 USD, capital virtuel 10 000 USD) via le même mécanisme que le
mode live spot : tout écart explicite est refusé par l'admission plutôt
que silencieusement écrasé.

## Admission au démarrage

| Entrée | Décision |
| --- | --- |
| produit configuré hors miroir (`BTC-USD`/`ETH-USD`) | refus `PERP_PRODUCT_NOT_ALLOWED` |
| champ différent de l'enveloppe figée | refus `PERP_POLICY_MISMATCH` |
| produit mappable mais admission perp non approuvée | refus `PERP_ADMISSION_REQUIRED` |
| flag ou secrets Hyperliquid absents | refus `HYPERLIQUID_EXECUTION_UNAVAILABLE` |
| enveloppe exacte + réglages présents | démarrage autorisé |

Aucune credential Coinbase n'est requise en mode perp : la relecture de
compte Coinbase du mode live n'est pas branchée. Le portefeuille local
sert à la comptabilité affichée ; l'équité **réelle** Hyperliquid alimente
le coupe-circuit (voir PnL journalier).

## PnL journalier réel (ancrage UTC)

La relecture de compte du cycle perp (`reconcileAccount`) porte
l'`accountValue` réel de `clearinghouseState` et l'exposition brute
`totalRawUsd`. Le mécanisme d'ancrage journalier UTC existant
(`models/daily-risk.ts`, `resolveDailyRiskWindow`) s'applique sans
changement : au premier cycle d'un jour UTC, la référence devient
cette équité réelle, et `dailyPnl = accountValue − référence`. Le
coupe-circuit de la garde (−1 000 USD) porte donc la perte **réelle**,
non réalisée incluse. L'échec de la lecture est une erreur de
réconciliation non retryable : le cycle échoue fermé plutôt que de
soumettre avec un PnL inconnu.

## Conversion d'une décision en intention perp

À la patte d'ordre, la décision du cœur (OrderIntent sur le produit
signal) est convertie purement :

1. `productId` signal → produit perp mappé ;
2. `quantity` arrondie vers zéro à `szDecimals` (`floorToSizeIncrement`) —
   jamais vers le haut ;
3. `markPrice` = dernier prix de marché du cycle ;
4. `leverage` = 1 : l'ordre passe en 1x effectif, la borne 2x de
   l'enveloppe est un plafond, pas un objectif ;
5. `side` inchangé (long et short autorisés).

Les gardes serveur s'appliquent ensuite sans aménagement : admission
réévaluée par le runner, garde de risque de la machine, coupe-circuit
journalier alimenté par la référence PnL jour de l'Agent, position et
exposition lues sur `clearinghouseState`.

## Invariants

1. Le cœur métier (indicateurs, stratégies, allocation, risque) est
   exactement celui du cycle spot : aucun calcul de trading dupliqué.
2. La venue est une couture d'effets : `tradingCycleMachine` ne connaît
   pas Hyperliquid.
3. Un produit signal non mappable ne peut pas démarrer en mode perp.
4. Le mode perp n'exige aucune credential Coinbase ; le mode live spot
   n'exige aucune clé Hyperliquid — les chaînes d'activation restent
   disjointes.
5. La quantité est arrondie vers zéro avant tout événement de machine.
6. Le PnL journalier de la garde vient de l'ancrage UTC existant
   (`daily-risk`) alimenté par l'`accountValue` réel — jamais une valeur
   inventée ni le portefeuille virtuel affiché.
7. Le kill switch en mode perp arrête la boucle et retire la
   planification : il n'appelle jamais Coinbase.
8. Les ordres perp passent en 1x effectif ; dépasser le plafond de
   l'enveloppe reste impossible.
9. L'équité affichée reste la comptabilité virtuelle ; le coupe-circuit,
   lui, lit l'équité réelle — un écart entre les deux ne peut
   qu'interdire un ordre, jamais en autoriser un faux.
