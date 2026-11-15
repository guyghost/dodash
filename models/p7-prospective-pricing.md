# P7 — pricing VWAP et valeur liquidable simulée

Statut : normatif pour préparation locale, 14 octobre 2026. Raffine
`p7-prospective-campaign.md`, sans changer stratégie, coûts 60/2 bps, seuils
ou garde du bot. Aucun marché, collecte, ordre, migration ou démarrage autorisé.

## Contrats purs

`models/p7-prospective-pricing.ts` fournit consommation de profondeur,
plan de pricing et projection liquidable. Le broker existant est réutilisé
dans un bridge local pour les fills ; pas de dépendance broker ajoutée au
package models. Aucun calcul de PnL réalisé à partir d'un averagePrice inventé.

- Book : identité BTC/ETH spot et profil, clock vérifiée, cache UNCACHED,
  dates/sequence/niveaux valides, comme `p7-prospective-quote.ts`.
- Pour les usages nouveaux, `asOf ≥ receivedAt`, `asOf − sourceObservedAt ≤5 s`,
  délai de fetch ≤5 s. Dates futures/absentes ne sont pas reconstruites.
- Exécution : intention persistée avant requête, prix choisi sur la quote
  persistée, pricing avant close+2 h inclus et T1 exclus. Reprise après
  expiration des 5 s => refus, pas de nouveau prix. Les checks de réception
  déjà persistés ne sont pas réinterprétés ni les reçus V1 réécrits.
- Mark : pas de faux candleClosedAt/intentPersistedAt. Les observations
  sont admissibles toute la campagne ; asOf=T1 permis pour une estimation
  finale sur quote reçue **avant** T1 et encore fraîche. Aucun fill à T1.

## VWAP pour quantité figée

BUY consomme les asks ascendants ; SELL les bids descendants. Sur chaque
niveau : `take = min(remaining, level.quantity)`, cumul `price × take`.
VWAP = notionnel brut consommé / quantité demandée.

Toute quantité >0 doit être entièrement couverte. Pas d'extrapolation au
dernier prix, de fill partiel, de redimensionnement ni de tolérance de volume
qui inventerait une profondeur absente. Rejeter les niveaux invalides,
désordonnés/dupliqués, valeurs non finies et débordements/sous-flux numériques.
La consommation est une simulation sur un snapshot, pas une réservation réelle.

La fonction de profondeur ne valide pas la fraîcheur à elle seule. Le plan
de pricing vérifie d'abord quote/contexte puis side/quantité et profondeur.
`PRICING_READY` fournit le **VWAP brut**, jamais un prix déjà slippé au broker.

## Fill simulé et pont vers le registre

Le bridge `docs/analysis/p7-prospective-pricing.mjs` lit un export revalidé du
store local, l'intention et l'unique OBSERVE_QUOTE du slot. Pas de prix/carnet
alternatif fourni par l'appelant. Il ne fait aucun fetch ni commit automatique.

Appeler `executePaperOrder` avec VWAP brut et `{ feeBps:60, slippageBps:2 }` :

```text
fillPrice = VWAP × (1 + sideSign × 0,0002)
fee = fillPrice × quantity × 0,006
```

Spread déjà pris via asks/bids : pas de second spread. Cash insuffisant ou
position insuffisante => BROKER_REJECTED ; profondeur/quote => QUOTE_REJECTED.
Le bridge retourne un fait terminal et les balances simulées, pas un fill
exchange, une autorisation de risque ou une transition live. Le registre
existant committe issue/balances via ses gardes et ses versions.

La soumission transactionnelle complète du bridge et la revalidation au
commit effectif restent à câbler avant collecte. Les commandes V1 déclarées
du store restent destinées aux fixtures ; elles ne deviennent pas des preuves
de pricing vérifié. Reprise terminale : reçu durable, pas un nouveau pricing.

## Valeur liquidable (aucun ordre)

Pour `cash ≥0`, `q ≥0`, finis, q>0 et carnet valide couvrant q sur les bids :

```text
VWAP_bid = bidNotional(q) / q
estimatedSellPrice = VWAP_bid × (1 − 0,0002)
estimatedExitFee = estimatedSellPrice × q × 0,006
liquidablePositionValue = estimatedSellPrice × q − estimatedExitFee
equity = cash + liquidablePositionValue
```

Le cash contient déjà les frais simulés des fills passés : ne pas les
retrancher à nouveau. Les frais de sortie sont une **estimation**, ne modifient
ni cash, position, version ni journal, et ne créent aucune vente simulée.

Position plate explicitement connue (q=0) : equity=cash, source=CASH, pas de
prix ni timestamp amont inventé. Cela prouve la valeur du cash, pas une
disponibilité marché ou une admission. Portfolio invalide/absent ≠ cash plat.
Position ouverte sans quote/profondeur suffisante : UNAVAILABLE/equity null,
jamais coût d'acquisition, close, dernier bid extrapolé ou zéro substitué.

Consolidation : exactement BTC et ETH, même asOf, chaque mark disponible et
valeur finie ; sinon equity null. Ne pas mélanger des heures ou masquer un
produit manquant. Le DD futur restera une mesure échantillonnée, pas une
garantie de valeur réalisable intraday ou d'acceptation d'ordre.

## Verify / limites

Tests synthétiques avant implémentation : VWAP multi-niveaux buy/sell,
quantité exactement couverte et dépassement, book/clock/source invalides,
5 s et 2 h/T1, mark hors fenêtre daily mais dans la campagne, cash plat,
double comptage des frais, portefeuille non muté, consolidation incomplète.
Tests bridge avec **vrai broker** et SQLite local : quote figée, refusal cash,
fact terminal et réouverture sans débit supplémentaire.

Calcul B&H au budget/précision du profil, marks persistés/exports/anchors,
machine globale, source/T0, risques et collector demeurent des incréments
séparés. Aucune preuve prospective n'est produite par ces tests.
