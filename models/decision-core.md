# Modèle du cœur de décision

Le cœur de décision est composé de trois fonctions pures en chaîne :

`indicateurs + marché → stratégies → allocation → risque`

## Stratégies

Chaque stratégie implémente le même contrat et retourne exactement un `Signal` typé.

- `rsi-reversion` : BUY sous le seuil survendu, SELL au-dessus du seuil suracheté, sinon HOLD.
- `ema-cross` : agit uniquement lors d’un croisement confirmé entre snapshot précédent et courant.
- `breakout` : compare la dernière clôture aux extrêmes de la fenêtre précédente.

Une erreur de données retourne un code fermé. Une stratégie ne lit ni horloge, ni réseau, ni état mutable.

Les décorateurs déterministes de calibration de confiance et de notional cible
font partie de cette frontière stratégique. Ils sont utilisables à l'identique
par le runtime et le backtest ; aucun des deux consommateurs ne possède leur
implémentation.

## Allocation

L’allocateur groupe les signaux actifs par produit, pondère chaque taille par la confiance, compense les avis opposés et produit au plus une intention par produit.

États de décision possibles :

- `NO_ACTION` : uniquement HOLD ou score net sous le seuil.
- `ALLOCATED` : une ou plusieurs intentions valides.
- `FAILED` : entrée ou contrainte numérique invalide.

## Risque

Le risque évalue chaque intention contre un snapshot explicite : prix, position, autre exposition, PnL journalier, dernier trade et instant courant fourni en entrée.

Ordre des gardes :

1. kill switch / perte journalière
2. cooldown
3. notional de l’ordre
4. position projetée
5. exposition brute projetée

Le premier refus gagne et retourne un `RiskReasonCode`. Une approbation fournit des niveaux de stop-loss et take-profit déterministes.

## Invariants

1. Un signal HOLD ne devient jamais un ordre.
2. Des signaux opposés sont arbitrés avant le risque ; ils ne créent jamais deux ordres contradictoires.
3. Une allocation ne dépasse ni le capital disponible ni le notional maximal de décision.
4. Le risque ne modifie pas une intention ; il l’approuve ou la rejette.
5. Aucune sortie LLM ou texte libre ne pilote une décision. Seuls les types et codes fermés sont consommés.
6. Le runtime de trading ne dépend jamais du paquet de backtest. Les deux
   dépendent de frontières fonctionnelles communes.
7. L'exécution paper est un adaptateur déterministe distinct du cœur de
   décision ; elle ne contient ni I/O ni transition d'état.
