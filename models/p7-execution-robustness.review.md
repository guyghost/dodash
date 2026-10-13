# Revue préalable — robustesse P7

**APPROUVÉ POUR REPLAY HISTORIQUE HORS RÉSEAU**, après approbation explicite
de l'opérateur. Aucun changement de stratégie, config paper ou gate live.

- Six scénarios gelés avant résultats ; aucune sélection de la meilleure
  hypothèse a posteriori. Référence identique au test runtime existant.
- Signal causal : la fenêtre de décision ne contient pas l'open suivant.
  L'intention conserve sa quantité ; les refus cash sont des résultats.
- Les paramètres économiques connus du scénario alimentent la même formule
  de sizing ; pas d'optimisation de SMA/vol/ancres/dérive.
- Slippage appliqué une fois dans le broker réel ; frais calculés sur le
  notionnel effectivement rempli. Pas de coût forfaitaire inventé en plus.
- Calendrier et fenêtres complets ; initial capital, ETH pré-cotation en cash,
  risque par créneau et portefeuille indépendant identiques à la référence.
- Limites assumées : open proxy sans minute, risque de bougie conventionnel,
  fills complets simulés, pas de carnet/impact ni liquidation finale. Les
  stress ne prouvent pas la disponibilité quotidienne, l'OOS ou l'exécution live.
- XState orchestre le lot ; assesseur pur décide les verdicts. Les erreurs
  de dataset ou de référence ferment le run au lieu d'élargir les tolérances.

Vérification à réaliser : tests synthétiques, référence, six scénarios réels,
empreintes, invariants cash/position et rapport non extrapolatif.
