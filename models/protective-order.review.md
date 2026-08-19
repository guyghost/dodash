# Revue du modèle de l’ordre protecteur

| Cas | Décision explicite |
| --- | --- |
| Politique `NONE` | aucun acteur, replay historique inchangé |
| Bps, multiplicateur ou ATR invalide | `failed`, aucun ordre |
| Position nulle ou prix de revient invalide | `failed`, aucun ordre |
| Gap sous le stop | clôture totale à l’open avant slippage |
| Gap au-dessus de l’objectif | clôture totale à l’open avant slippage |
| Stop seul touché dans la bougie | clôture à la référence stop |
| Objectif seul touché | clôture à la référence objectif |
| Stop et objectif touchés | stop-first conservateur |
| Bougie dupliquée, inversée ou plage avant ouverture | `failed` |
| Achat supplémentaire | nouveaux seuils depuis le prix moyen et l’ATR causal |
| Vente partielle | quantité réduite, seuils inchangés |
| Vente totale de stratégie | annulation terminale du bracket |
| Nouveau trade après terminal | nouvel acteur, aucun recyclage implicite |
| Signal de stratégie et gap au même open | gap résolu d’abord, puis ordre planifié |
| Trigger protecteur et réentrée au même open | nouvel acteur, puis plage rejouée |
| Erreur broker sur la clôture | échec fermé du replay, aucun retry implicite |

La convention stop-first interdit qu’un ordre des prix intrabougie soit inventé.
Elle est volontairement pessimiste et identique pour toutes les stratégies. Les
sorties sont des market-on-trigger simulées : le prix de référence est soumis
aux frais et au slippage du broker papier, y compris pour l’objectif.

Le calcul des seuils et la résolution OHLC appartiennent au cœur pur. La machine
XState ne fait que valider la séquence `open → range`, conserver le plan et
choisir un état terminal. Le replay orchestre les fills et ne duplique aucune
règle de déclenchement.

La revue couvre nominal, erreurs, annulation, réarmement, réduction, gap,
ambiguïté et états terminaux. Aucun retry n’est autorisé : le calcul est local et
déterministe. Les permissions live, la persistance et les ordres Coinbase ne
font pas partie de cet acteur de backtest.
