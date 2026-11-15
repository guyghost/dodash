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
