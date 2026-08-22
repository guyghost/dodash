# Revue — Diagnostic attribution des rejets du risk engine

Statut : APPROUVÉ

Objet : `models/risk-rejection-diagnosis.md` (MODÉLISÉ → REVU).

## Vérifications code

1. **Binary checkRisk** — `packages/risk/src/risk.ts` L32-40 :
   `RiskDecision` est `APPROVED | REJECTED { reasonCode }`. Les 7
   codes (L23-30) correspondent exactement à l'union miroir
   proposée. Aucune réduction partielle n'existe — « rejet » =
   ordre droppé entier. ✔
2. **Drop silencieux** — `replay.ts` L673
   (`if (risk.value.status === "REJECTED") continue;`) : le motif
   est perdu aujourd'hui ; l'instrumentation au point de drop est le
   seul endroit fidèle. ✔
3. **Anomalie dailyPnl** — `replay.ts` L665 :
   `dailyPnl: equityBefore - config.initialCapital`. Confirmé
   cumulatif. Le seuil de rejet (risk.ts L85-87) est
   `dailyPnl <= -maxDailyLoss` ⟺ `equity ≤ 9 000` sous config V1.
   H1 correctement formulée comme **sémantique déviante** (le
   modèle de risk dit « daily »). ✔
4. **Granularités** — `backtest-diagnostics.ts` L170-188 :
   `riskEvaluated` = `allocatedNotional > 0` ; rejet par **décision**
   avec tolérance (L55). Le modèle documente la différence
   décision/ordre pour `riskRejectionReasons` — nécessaire et
   suffisante pour Q1. ✔
5. **INV-D2 (cohérence)** — ordres à quantité strictement positive
   (le pathway `minNetQuantity` 1e-6 filtre les nets nuls ;
   l'allocation n'émet pas d'ordres à quantité nulle) : toute
   décision avec ≥ 1 ordre droppé a `approved < allocated − tol` et
   réciproquement. La contraposée tient. ✔
6. **Impact compilation** — constructeurs d'
   `AllocationDiagnosticObservation` : `replay.ts` (L677) et
   `models/backtest-diagnostics.test.ts` (L68-80, L221).
   `packages/backtest/test/backtest.test.ts` L271-278 utilise
   `toMatchObject` → insensible au champ ajouté. Aucun autre
   constructeur (grep `requestedNetNotional:`). ✔
7. **Autonomie de models/** — `models/package.json` : dépendances
   `xstate` uniquement. L'union miroir est la seule option sans
   inverser le layering ; le verrou d'assignabilité bidirectionnelle
   avec `RiskReasonCode` (`@dodash/risk`) empêche le drift. ✔
8. **INV-D1 (zéro comportement)** — la collecte des motifs se fait
   dans la branche `REJECTED` existante ; aucune valeur du chemin
   d'exécution ne change. Contrôle baselines WF2 2023/2025 réutilisé. ✔

## Risques et acceptation

- **R1 — Champ requis sur l'observation** casse les constructeurs
  externes éventuels (non détectés par grep dans ce repo). Accepté :
  paquets privés, migration dans le même commit.
- **R2 — Le compteur par ordre peut sembler > riskRejectedCount**
  (une décision rejetée peut dropper plusieurs ordres). Accepté :
  granularités documentées dans le modèle (§4).
- **R3 — 40 runs ≈ 50 min.** Accepté : réutilisation exacte du
  harnais walk-forward, comparabilité directe avec les chiffres §6.

## Verdict de revue

Le modèle couvre : mesure sans effet de bord (INV-D1), attributs de
validation (INV-D2/D3), hypothèses falsifiables avec prédictions
temporelles distinctes (H1 binaire dans le temps vs H2 diffus),
décisions sortantes explicitement différées (§6). **Approuvé sans
corrections.**
