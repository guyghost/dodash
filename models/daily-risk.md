# Fenêtre de risque journalier — contrat et source d'équité paper

Statut : normatif. Amendement 2026-09-28 (suite de l'analyse paper du 28-09).

## 1. Contrat existant (inchangé)

`resolveDailyRiskWindow(current, now, markedEquity)` ré-ouvre la fenêtre au
changement de jour UTC avec `openingEquity = markedEquity` et retourne
`dailyPnl = markedEquity − openingEquity`. Le prédicat `DAILY_LOSS_LIMIT` de
`checkRisk` consomme `dailyPnl`. La fonction ne choisit ni source de prix ni
politique de fraîcheur : l'appelant en est responsable.

## 2. Défaut corrigé

En paper, l'appelant fournissait `cash + quantité × (dernier close connu ??
averagePrice)`. Après deux échecs marché consécutifs, le dernier close disparaît
du résumé de cycle et l'équité retombe au coût d'acquisition ; si ce repli se
produit au premier cycle d'un jour UTC, la fenêtre s'ouvre au coût et `dailyPnl`
mesure `mark − coût` toute la journée, puis s'inverse le lendemain. La phase
`reconcilingAccount` paper ré-ancrait également la fenêtre sur le coût.

## 3. Source d'équité paper

- La seule équité marquée paper est `projectPaperValuation({ cash,
  positionQuantity, mark: lastPaperMark, asOf })`. Le mark est le dernier
  accepté (`models/paper-valuation.md`), daté ; `averagePrice` n'est jamais un
  mark de repli.
- `resolvePaperDailyRisk(current, currentDailyPnl, now, valuation)` :
  - si `valuation.ok` et `valuation.value.equity !== null` (qualité `fresh` ou
    `stale`) : `resolveDailyRiskWindow(current, now, equity)` ;
  - sinon : `{ window: current, dailyPnl: currentDailyPnl }`, porté inchangé.
    Une fenêtre UTC ne s'ouvre jamais sur une équité indisponible ni au coût.
- Un mark `stale` reste une équité numérique légitime pour la continuité de la
  fenêtre : la dernière valeur connue, datée. Sa qualité est publiée par la
  télémétrie de valorisation du même cycle.
- Début de cycle : `asOf = triggeredAt`, mark = `lastPaperMark` courant.
  Fin de cycle : mark accepté du cycle (nouveau snapshot ou précédent), appliqué
  au portefeuille post-fill.
- Dans l'interpréteur, les réconciliations paper (`reconcilingAccount`,
  `ORDER_CONFIRMED`, `NO_SELL_NEEDED`, `PROTECTION_FAILED`) ne ré-ancrent plus
  la fenêtre : `dailyRiskWindow`/`dailyPnl` du résultat sont ceux fournis en
  entrée. Live et perp gardent leurs réconciliations réelles.

## 4. Invariants

1. À portefeuille constant et mark constant, `dailyPnl` est constant, quel que
   soit le succès ou l'échec des cycles intermédiaires.
2. Un échec marché ne change ni `openingEquity` ni `dailyPnl`.
3. Le premier cycle d'un jour UTC sans mark disponible ne crée pas de fenêtre ;
   la fenêtre s'ouvre au premier cycle disposant d'un mark, avec l'équité de ce
   mark.
4. Aucun seuil, aucune transition XState, aucun consommateur live/perp ne change.
5. Une instance restaurée avec position ouverte et sans mark porte sa fenêtre
   héritée jusqu'au premier snapshot accepté.

## 5. Vérification requise

- Deux échecs consécutifs puis cycle réussi : `dailyPnl` identique avant/après.
- Premier cycle du jour en échec : aucune ouverture ; ouverture différée au
  premier mark ; `openingEquity` = équité au mark.
- Mark stale : fenêtre résolue, valeur numérique conservée.
- Portefeuille plat sans mark : équité = cash, fenêtre résolue.
- Caractérisation : `checkRisk` reçoit `dailyPnl` du runtime ; live/perp inchangés.
