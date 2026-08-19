# Modèle de résolution d’exécution multi-timeframe

Le replay peut recevoir deux séries OHLCV distinctes pour un même produit et
les mêmes bornes :

- la série **primaire** pilote indicateurs, stratégies, allocation, risque,
  equity et progression du run ;
- la série **d’exécution** ne pilote que l’ordre temporel des gaps et plages
  consommés par l’acteur `protectiveOrder`.

L’absence de série d’exécution conserve une résolution `1:1` : chaque bougie
primaire est sa propre bougie d’exécution.

## Construction du planning

Avec une série d’exécution explicite, les intervalles des deux séries sont
constants et strictement positifs. L’intervalle primaire doit être un multiple
entier strictement supérieur de l’intervalle d’exécution.

Pour un ratio `r = primaryDuration / executionDuration`, chaque bougie primaire
reçoit exactement `r` sous-bougies :

```text
primary[t]
  ├─ execution[t, 0]  start = primary.start
  ├─ execution[t, 1]
  ├─ ...
  └─ execution[t, r-1] end = primary.start + primaryDuration
```

La première et la dernière bougie primaires doivent être entièrement couvertes.
Aucune sous-bougie antérieure, supplémentaire, manquante, dupliquée ou
chevauchante n’est acceptée.

## Cohérence d’agrégation

Chaque groupe de sous-bougies doit reconstruire la bougie primaire :

- `primary.open = firstExecution.open` ;
- `primary.close = lastExecution.close` ;
- `primary.high = max(execution.high)` ;
- `primary.low = min(execution.low)`.

Les prix utilisent une tolérance machine relative, sans tolérance métier. Le
volume est validé dans chaque série par le domaine, mais n’est pas un invariant
d’agrégation : Coinbase peut réviser les volumes d’une granularité sans réviser
l’autre, et le volume secondaire ne participe à aucune décision ni aucun effet
du replay. Une incohérence O/H/L/C ferme le replay avant tout fill.

## Ordre des phases

Pour chaque bougie primaire :

1. pour la première sous-bougie, résoudre le gap d’un bracket existant ;
2. exécuter les ordres de stratégie en attente à cette ouverture uniquement ;
3. armer, réarmer, réduire ou annuler le bracket selon les fills ;
4. résoudre la plage `high/low` de cette sous-bougie ;
5. pour chaque sous-bougie suivante, résoudre `open`, puis `high/low`, sans
   réévaluer ni exécuter la stratégie ;
6. après la dernière sous-bougie, marquer l’equity au close primaire, calculer
   les indicateurs primaires et produire la décision pour l’ouverture primaire
   suivante.

Un trigger protecteur utilise le timestamp et le prix de référence de la
sous-bougie qui l’a déclenché. Les frais et le slippage restent ceux du broker
papier.

## États et responsabilités

Le workflow `backtestRun` reste dans `replaying` pendant toute la boucle. Il ne
reçoit qu’une progression en bougies primaires. Chaque acteur
`protectiveOrder` conserve sa séquence explicite `awaitingOpen → awaitingRange`
pour chaque sous-bougie. Le planning est un cœur pur : il groupe et valide des
valeurs, sans I/O, horloge, réseau ou état mutable.

## Invariants

1. Une stratégie ne voit que les bougies primaires clôturées.
2. Un ordre de stratégie ne s’exécute qu’au premier open d’une bougie primaire.
3. Les sous-bougies ne produisent aucun indicateur, signal, allocation ou ordre
   de stratégie.
4. Chaque sous-bougie est consommée exactement une fois, `open` avant `range`.
5. Le planning couvre exactement les bornes et reconstruit l’O/H/L/C de chaque
   bougie primaire.
6. La progression et l’equity curve restent exprimées en bougies primaires.
7. Sans série secondaire, le résultat est bit pour bit identique au replay 1:1.
8. Avec une politique `NONE`, une série secondaire valide ne modifie aucun fill,
   portefeuille, point d’equity ou métrique.
9. Une série secondaire invalide échoue avant le premier effet de replay.
10. La résolution plus fine n’active jamais le trading live.
