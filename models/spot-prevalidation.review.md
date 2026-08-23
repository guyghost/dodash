# Revue — Pré-validation spot amont (`spot-prevalidation.md`)

Verdict : **APPROUVÉ** avec 2 notes (aucun blocage).

## Vérifications code

1. **Prédicat miroir** — risk.ts L100-104 : `signedQuantity = side === "BUY" ? quantity : -quantity` ; rejet ssi `currentPositionQuantity + signedQuantity < -1e-12`. Le modèle §3 reprend exactement ce prédicat et la tolérance `1e-12`. ✔
2. **Un ordre par décision** — allocator.ts L74-125 : un ordre netted par groupe produit ; replay single-product (`config.productId`, marketPrices à une entrée). `spotInexecutableNotional > 0` ⟺ ≥ 1 ordre abandonné. INV-S3 vérifiable. ✔
3. **Chemin d'exécution** — replay.ts L708 : `pendingOrders = approvedOrders` ; les ordres pré-droppés n'atteignent jamais le broker. L'ensemble exécuté est inchangé par construction (INV-S1). ✔
4. **Équivalence drop** — checkRisk est terminal sur rejet : un ordre `SPOT_SHORT_FORBIDDEN` était droppé ; il est désormais droppé un étage plus tôt. Aucune autre branche amont (kill/daily/cooldown/orderNotional) ne tire sous V1 (mesuré : 0 occurrence/40 runs) → raison et économie inchangées sous V1. ✔
5. **Observations** — constructeurs à mettre à jour : replay.ts L696-707 et models/backtest-diagnostics.test.ts. backtest.test.ts L271-278 utilise `toMatchObject` → insensible. ✔
6. **Mesure redéfinie** — `riskEvaluated`/rejet passent de `allocatedNotional` à `spotExecutableNotional` ; `capRate` inchangé sur `allocatedNotional`. Cohérent avec l'étagement allocation → spot → risk. ✔
7. **Consommateurs aval** — le sélecteur (`riskRejectionRate = 0`, raison `RISK_REDUCED`) devient satisfaisable pour IDENTITY sans modification de code : effet de sémantique voulu. ✔
8. **Live** — interpreter.ts L338-350 : drop via `RISK_REJECTED`, économie identique ; non-câblé ce cycle, documenté §8 du modèle. ✔

## Notes

- **N1 (verrou de drift)** — la tolérance et le prédicat sont dupliqués
  entre `models/spot-permission.ts` et `packages/risk/src/risk.ts`.
  Verrou : test d'équivalence sur grille (side × quantity × position)
  dans packages/backtest (dépend des deux paquets) —
  `INEXECUTABLE ⟺ checkRisk = SPOT_SHORT_FORBIDDEN`.
- **N2 (précédence)** — INV-S2 correct : si kill switch/daily loss
  coexistaient avec une inexécutabilité spot, l'attribution passerait
  de `KILL_SWITCH_ACTIVE`/`DAILY_LOSS_LIMIT` à spot-abandon. Economie
  identique (drop dans les deux cas) ; sous V1, non observable.

## Risques acceptés

- **R1** — `spotInexecutableCount` compte des décisions, pas des
  ordres (≈ équivalent single-produit single-ordre). Documenté.
- **R2** — La métrique `riskRejectionRate` change de sémantique
  (dénominateur restreint) : les comparaisons historiques doivent
  passer par `spotInexecutableNotional` pour reconcilier. Documenté §4.
