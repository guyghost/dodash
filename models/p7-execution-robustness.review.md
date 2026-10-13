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

## Amendement de provenance avant métriques

Le premier lancement s'est arrêté sur la validation de l'archive ETH avant
le replay : son metadata annonce deux bougies déjà comblées, documentées dans
le rapport daily-long initial. L'opérateur approuve explicitement leur
conservation dans l'archive de référence. Contrôle exact BTC=0/ETH=2 et
publication de cette limite ; pas de nouveau remplissage, retrait de jour,
changement de scénario ou de seuil. Le contrôle initial trop strict n'est
pas requalifié comme une mesure économique échouée.

## Verify après implémentation

- Core pur : les fonctions réelles de décision/risque/broker sont réutilisées.
  La décision ne lit pas l'open futur ; les quantités ne sont pas redimensionnées.
- Shell : hash avant parsing, identité et comptes de remplissage exacts, grille
  et alignement ETH complets, sortie exclusive dans un répertoire neuf.
- 4 tests modèle et 6 tests Node passent, ainsi que la suite globale (530
  modèles, 313 agent, 133 backtest), check, build dry-run, lint ciblé et scan.
- C0 reproduit le test existant au bruit flottant ; second run déterministe
  (six trajectoires identiques octet par octet), bilans/frais/unicité vérifiés.
- Verdict conservé **SENSITIVE_TO_ASSUMPTIONS** : O3/O4 dépassent 50 % global,
  aucun scénario ou seuil retiré. Rapport :
  `docs/analysis/p7-execution-robustness-2026-10-13.md`.

**Accepté comme étude de sensibilité historique uniquement.** Aucune
modification de P7, de la config paper ou de la politique de lancement live.
