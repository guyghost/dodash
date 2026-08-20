# Modèle de politique live

La politique live est une admission fermée placée avant l'événement
`START_REQUESTED` de `tradingCycleMachine`. Elle ne crée pas une seconde
machine métier : elle décide uniquement si une configuration live explicite
peut recevoir les permissions déjà consommées par la machine de trading.

## Enveloppe confirmée

La politique `CONFIDENCE_POWER_THIRD_2026_08` autorise uniquement :

- produits : `XTZ-USD`, `ZEC-USD`, `GRT-USD`, `MANA-USD` ;
- marché : spot long-only ;
- timeframe de décision : `ONE_DAY` ;
- stratégies dans une instance commune : `rsi-reversion`, `ema-cross`,
  `breakout` ;
- sizing : notionnel signal cible de 1 000 USD, `POWER_THIRD` pour
  `ema-cross` et `breakout`, identité pour `rsi-reversion` ;
- capital virtuel de risque : 10 000 USD par produit ;
- ordre : 600 USD maximum ;
- position : 10 000 USD maximum ;
- exposition brute : 20 000 USD maximum par produit ;
- perte journalière : 1 000 USD maximum par produit ;
- cooldown : 0 ms ; stop indicatif : 150 bps ; take-profit indicatif :
  300 bps ;
- polling : une heure, avec une fraîcheur maximale de deux heures ;
- 200 bougies de warmup et quantité nette minimale `0.000001`.

Les tailles soumises à Coinbase sont arrondies vers le bas à l'incrément de
base vérifié lors du préflight du 20 août 2026 : `0.01` pour GRT, MANA et XTZ,
et `0.00000001` pour ZEC. Un résultat inférieur à un incrément est refusé
localement.

Les quatre instances peuvent donc représenter au plus 40 000 USD de capital
virtuel, 80 000 USD d'exposition brute configurée et 4 000 USD de perte
journalière configurée. Aucune limite n'est mutualisée entre produits.

## Admission

| Entrée | Décision |
| --- | --- |
| mode `paper` | hors de cette politique |
| produit absent de l'allowlist | refus `LIVE_PRODUCT_NOT_ALLOWED` |
| champ différent de l'enveloppe figée | refus `LIVE_POLICY_MISMATCH` |
| enveloppe exacte | admission `APPROVED` |

Une instance live utilise le nom canonique `<produit-en-minuscules>--multi`
(par exemple `grt-usd--multi`). Un autre nom est refusé avec
`LIVE_AGENT_NAME_MISMATCH` afin d'empêcher plusieurs portefeuilles virtuels de
contourner les limites d'un même produit.

Le shell doit ensuite vérifier séparément le coupe-circuit
`LIVE_TRADING_ENABLED=true` et les credentials Coinbase. Un refus ne produit
aucun événement `START_REQUESTED` et ne modifie pas l'état durable.

## Une seule décision par bougie

`tradingCycleMachine` mémorise `lastDecisionCandleClosedAt`.

| État | Événement | Garde | Transition |
| --- | --- | --- | --- |
| `fetchingMarketData` | `MARKET_DATA_READY` | clôture déjà traitée | `persisting`, issue `NO_ACTION` |
| `fetchingMarketData` | `MARKET_DATA_READY` | nouvelle clôture fraîche | `computingIndicators` |
| `fetchingMarketData` | `MARKET_DATA_READY` | nouvelle clôture périmée | retry borné, puis `NO_ACTION` et replanification |

Une clôture est déjà traitée si elle est inférieure ou égale à la dernière
clôture enregistrée. La clôture est enregistrée avant les calculs : un crash ou
un échec ultérieur ferme donc la bougie sans permettre un second ordre.
`RESET` et un redémarrage live conservent cette valeur.

## PnL journalier

Chaque Agent conserve un jour UTC et l'equity de référence au début de ce
jour. Au premier cycle d'un nouveau jour, la référence devient la dernière
equity marquée connue. Le risque reçoit `equity courante - equity de référence`.
Cette référence survit aux arrêts et redémarrages live.

## Invariants

1. Un produit hors allowlist ne peut jamais atteindre `START_REQUESTED` en live.
2. Aucun champ de risque live ne peut dépasser ou contourner l'enveloppe figée.
3. Une bougie quotidienne ne peut produire au plus qu'une évaluation de
   stratégies, y compris après retry, reset ou redémarrage.
4. Le sizing live reproduit l'ordre de composition du protocole : calibration
   EMA/breakout, puis sizing notionnel de toutes les stratégies.
5. Le profil RSI reste `IDENTITY`.
6. Le mode paper conserve son sizing natif et ses valeurs par défaut.
7. Le flag et les secrets restent des effets du shell et ne vivent jamais dans
   le modèle, l'état durable ou les logs.
8. La résolution historique `SIX_HOUR` n'est pas présentée comme une horloge
   live : l'ordre live est un market IOC au premier polling suivant la clôture.
9. Les limites sont celles du portefeuille virtuel géré par l'Agent ; elles ne
   prétendent pas agréger les autres positions du compte Coinbase.
10. Les niveaux stop/take restent indicatifs tant qu'aucun ordre protecteur
    Coinbase n'est attaché ; ils ne doivent pas être décrits comme une
    protection live exécutée.
11. Une quantité live n'est jamais arrondie vers le haut pour satisfaire un
    incrément Coinbase.
12. Un produit live ne peut être démarré que sous son nom d'Agent canonique.
