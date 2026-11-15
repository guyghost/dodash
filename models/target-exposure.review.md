# Revue — politique d'exposition cible P7 (2026-10-10)

Revue indépendante du modèle `models/target-exposure.md` avant implémentation.

## Première lecture — CHANGES REQUIRED

| Point | Gravité | Décision intégrée |
| --- | --- | --- |
| `maxOrderNotional` / `maxPositionNotional` rejettent l'ordre entier, ventes comprises ; avec la croissance d'un créneau (> 20 k$), une sortie de tendance serait bloquée chaque jour | critique | INV-T7 + porte §4 : une réduction n'est bloquée que par le kill switch ; plafonds absolus neutralisés (≥ 1e9, validation) ; perte journalière bloque les achats seulement ; pas d'admission portefeuille pour une réduction |
| Le test de cohérence ne voyait pas le point précédent | important | le test rejoue `checkRisk` et le coupe-circuit consolidé ; un échec interdit le déploiement, jamais d'élargissement de tolérance |
| Plafond d'achat `cash / (1 + f + s)` dépasse le cash de l'exécution paper | important | `cash / ((1 + s)(1 + f))`, marge 1e-9 (détecté aussi par le test de cohérence) |
| Ordres d'ancre / début de mois manqués non rejoués (garde une décision par bougie) | important | documenté : rattrapage par la dérive ou l'ancre suivante |
| Ordre du minimum, formule de quantité, contiguïté de `d − 1`, `vol30 = 0`, valeurs non fixées, « exactement comme P7 » | clarification | précisés ; écarts à P7 reformulés comme écarts assumés |

## Seconde lecture — APPROVE

Les quatre points sont corrigés ; la porte de risque correspond à
`targetExposureRiskGate`. Deux tests de vérification ajoutés au §9 : refus
des plafonds < 1e9, vente bloquée par le kill switch.

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**, paper uniquement.
Fidélité : SMA200 incluant la clôture courante, vol échantillon √365 sur 30
rendements, exécution à la clôture, reconstruction d'ancre sans état
équivalente à P7 par créneau.

## Revue d'implémentation runtime — APPROVE (2026-10-10)

Revue indépendante du diff runtime (configuration, interpréteur, registre,
stratégie informative, config paper, runbook). Vérifié : paper uniquement sur
les chemins mono, multi et projection de créneau ; exclusivité INV-T6 ;
plafonds ≥ 1e9 y compris consolidé ; branche d'allocation compatible avec
`AllocationDecision` ; porte de risque limitée aux ventes ; aucun chemin live
ou perp modifié. Corrections intégrées avant commit :

- test du kill switch remplacé (le précédent annulait le cycle avant toute
  décision) : `checkRisk` refuse une réduction sous kill switch malgré la
  porte, l'accepte sans ;
- tests d'admission portefeuille : une vente l'évite, un achat y est soumis et
  peut être refusé ;
- `cooldownMs = 0` exigé par la validation (un cooldown pourrait bloquer une
  réduction, INV-T7) ;
- nettoyage (garde redondante, indentation).

Limite consignée : le test de cohérence rejoue les mêmes fonctions pures que
l'interpréteur (décision, porte, `checkRisk`, exécution paper), pas
`runTradingCycle` lui-même ; le câblage interpréteur est couvert par les tests
`apps/agent/test/target-exposure-runtime.test.ts`.

## Revue des retours PR #24 (2026-10-10)

Remarque Codex P1 : le coupe-circuit d'achat ne voyait jamais la perte du
jour (fenêtre journalière paper valorisée sur la nouvelle bougie seulement à
la fin du cycle). Correction relue indépendamment — **APPROVE** sur ce point :
`decisionCandlePnl` exact (position modifiée seulement aux clôtures, bougies
closes), porte d'achat sur `min(dailyPnl, pnlBougie)`, coupe-circuit consolidé
(en retard d'une bougie) neutralisé et consigné comme affaiblissement accepté
pour le paper ; aucune autre politique touchée ; test runtime rouge avant le
correctif ; test de cohérence aligné sur le runtime (CAGR 50,4 %, drawdown
max 47,2 %, pire fenêtre 35,2 %, 80 achats bloqués, 0 vente rejetée).

## Revue de l'amendement du 2026-11-15 — Filtre de coût d'exécution (No-Trade Zone dynamique)

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**

- **Pureté** : `roundTripCostFraction`, `resolveEffectiveDriftThreshold` et `resolveEffectiveMinOrderNotional` sont des fonctions pures déterministes sans effet de bord ni horloge ; elles bornent les entrées négatives ou non finies à `0`.
- **Invariants** : INV-T8 garantit qu'un changement de tendance (`ANCHOR`) n'est jamais bloqué par le filtre de coût ni par `minCostEdgeMultiple`. INV-T9 garantit la rétrocompatibilité bit-exacte quand `costAwareRebalance` est absent ou `false` (préservation du test de cohérence §7).
- **Cohérence économique** : la bande de non-échange s'élargit proportionnellement au coût aller-retour `2 * (feeBps + slippageBps) / 10_000`, et le notionnel minimal `effectiveMinOrderNotional` évite les ordres résiduels plafonnés par le cash dont le montant est faible au regard des frais sur l'équité du créneau.
- **Limites acceptées** : le runtime existant ne passe pas encore `costAwareRebalance: true` par défaut ; l'activation reste opt-in par l'appelant. Aucun impact sur les modèles voisins.

## Revue de l'amendement du 2026-11-15 — Admission mode `perp` (Hyperliquid)

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**

- **Sécurité et préservation de l'enveloppe Hyperliquid** : ouvrir `TARGET_EXPOSURE` à `executionMode: "perp"` ne contourne ni `admitHyperliquidPerpAgent` ni `assessPerpOrderIntent`. Les limites réelles sur Hyperliquid (`HYPERLIQUID_PERP_POLICY` : 600 $ / ordre, 10 000 $ position et exposition brute, perte journalière 1 000 $) restent strictement appliquées avant toute signature L1.
- **Isolation `"live"` spot et `"paper"`** : le mode `"live"` (Coinbase spot) reste strictement rejeté, et le mode `"paper"` conserve intégralement l'exigence des plafonds neutralisés `>= 1e9` (`INV-T7`).
- **Limite opérationnelle documentée** : du fait du plafond `maxOrderNotional = 600` de `HYPERLIQUID_PERP_POLICY`, les ordres unitaires P7 en `"perp"` dont le notionnel dépasse 600 $ sont refusés par `checkRisk` / `assessPerpOrderIntent` tant que l'enveloppe Hyperliquid figée reste à 600 $ ; le fonctionnement nominal est donc dimensionné pour des créneaux de taille adaptée (ou rééquilibrages progressifs ≤ 600 $). Aucune modification du modèle `hyperliquid-execution.ts` requise.
