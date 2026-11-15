# Évolutions paper — modèle proposé au 26 septembre 2026

Statut : BROUILLON POUR DÉLIBÉRATION. Aucun amendement normatif adopté.
Ce document décrit les propositions VALUATION, DIAGNOSTICS, RETRIES, HISTORY
et CAMPAIGN ; leurs identifiants DAO sont consignés dans le rapport associé.
Source factuelle : `docs/analysis/analyse-paper-session-2026-09-26.md`.

La séquence obligatoire est Model → Review → Implement → Verify. Cette livraison
prépare Model et une revue documentaire ; elle n'implémente aucune transition.
Les décisions de trading restent déterministes. Un éventuel AI Worker ne fournit
que des signaux ; aucun LLM ne décide d'un retry, d'une admission ou d'un verdict.

## VALUATION — valeur du portefeuille paper et qualité de la mesure

Modèles à amender : `paper-valuation.md` et son projectionneur pur,
`trading-telemetry.md`, `agent-runtime.md`, `dashboard-pnl-history.md`,
`dashboard-portfolio-summary.md`, et contrat `daily-risk.ts`.

Entrées : portefeuille après exécution (cash, quantité, frais comptabilisés),
prix de valorisation, produit, origine du prix et date d'observation, horloge
injectée, fenêtre journalière persistée. Distinguer coût d'acquisition, dernier
close et prix courant : ils ne sont pas interchangeables.

Projection pure normative : `equity = cash + quantity * valuationPrice`, avec
`candleClosedAt`, source et qualité dérivés selon `models/paper-valuation.md`.
La qualité est un résultat calculé (`fresh | stale | unavailable`), pas une
machine persistée : elle n'ajoute aucune transition de trading. Un mark périmé
reste affichable avec sa date et son âge; un mark absent n'est pas remplacé par
le coût d'acquisition.

Effets : publier et persister la même mesure datée pour API, dashboard et AE ;
projeter l'exposition consolidée depuis l'état portefeuille et la qualifier.
Ne pas présenter le `otherExposureNotional: 0` du stub paper comme une mesure.

Invariants : une baisse de prix d'une position longue fait baisser sa valeur ;
une exécution est valorisée après son fill ; aucun double comptage des frais ;
une panne de marché ne retransforme pas le coût d'acquisition en valeur fraîche ;
aucune altération de l'ancrage journalier ou des seuils de risque dans #62.
Vérifier les chemins mono-produit et portefeuille, achat, vente partielle,
absence de fill, erreur marché, redémarrage et changement de jour UTC.

## DIAGNOSTICS — expliquer les décisions et les erreurs récupérées

Modèles à amender : `trading-telemetry.md`, `market-data-integrity.md`, contrat
de sortie du cycle ; aucune nouvelle transition nécessaire pour l'observation.

Entrées : cycleId, runId, productId, timeframe, version/configuration, attempts,
code terminal, causes détaillées fermées, candleClosedAt et état d'évaluation.
Distinguer : erreur terminale / erreur récupérée ; répétition de bougie /
absence de signal / bougie hors fenêtre d'âge ; refus risque et raison.
Événements observés : MARKET_DATA_FAILED, MARKET_DATA_READY, terminaison du cycle.
Ils produisent une projection diagnostique, jamais une nouvelle décision.

Effets : un événement terminal par cycle, compteurs bornés de tentatives,
marketFailureCause (CANDLE_TOO_OLD, TICKER_INCOHERENT, etc.), métriques de
prix/âge et projection AE versionnée. Garder blob6/blob7 compatibles avec
les consommateurs existants. Ne pas effacer l'historique de retry pour rendre
les graphiques verts ; ajouter une distinction explicite.

Invariants : aucun secret ou corps brut ; absence de preuve ≠ succès ;
les métriques ne commandent pas la machine ; un ORDER_CONFIRMED avec retry
récupéré reste une exécution réussie ; un FAILED reste un échec terminal.
Vérifier OLD_CANDLE vs TICKER_INCOHERENT, succès après 429, répétition de bougie,
absence de signal et conservation des compteurs malgré redémarrage.

## RETRIES — calendrier borné et persistant après 429

Modèles à amender : `trading-cycle.md`, `trading-cycle.machine.ts`,
`agent-runtime.md`, contrat du service marché. Dépend de DIAGNOSTICS.

Entrées : erreur, Retry-After validé, tentative, horloge injectée, deadline de
validité de la décision, état de contrôle opérateur et calendrier portefeuille.
Politique chiffrée (budget, délai plafond, délai par défaut) à figer en revue,
avant implémentation ; aucune valeur arbitraire adoptée dans ce brouillon.

Machine XState requise : fetching → retryScheduled sur 429 retryable ;
retryScheduled → fetching uniquement sur RETRY_TIMER_ELAPSED à/au-delà de
nextRetryAt et avant deadline ; fetching/retryScheduled → persistedFailure
sur budget épuisé/deadline dépassée ; STOP/KILL conservent leur priorité.
Événement de restauration : recharger nextRetryAt sans relancer immédiatement.

Effets : persistance avant programmation de l'alarme ; relecture marché après
délai ; propagation bornée de Retry-After ; calendrier partagé respectant
l'indépendance des produits (INV-P3), sans écraser le réveil d'un autre actif.

Invariants : pas de busy loop ni long sommeil en mémoire ; pas d'ordre sur un
signal expiré ; aucune augmentation tacite du budget de retry ; pas de double
ordre ; aucune mutualisation de capital ; aucune rotation d'IP ou stratégie
de contournement du fournisseur. Vérifier avec horloge simulée, panne/reprise,
429 consécutifs, timeout, stop/kill et deux produits aux échéances distinctes.

## HISTORY — corriger les preuves de performance historiques

Modèles concernés : protocole d'évaluation et `trading-telemetry.md`.
Entrées : fenêtre bornée et versionnée, équité compatible, fills, coûts positifs,
qualité et pondération des observations. Précondition : sources reconstituables.

Calculs purs : `net = gross - costs`, donc `gross = net + costs`.
Ne pas confondre contribution brute estimée, mouvement d'équité pendant les
fills, rendement d'une stratégie, win rate liquidatif et gain moyen d'un trade.
Calculer le drawdown depuis le maximum antérieur, pas depuis le capital initial.

États documentaires : unverified → reconciled si identités et sources validées,
sinon unverified → inconclusive. Effets : rapport corrigé avec erratum traçable,
calculateur reproductible et sources conservées ; aucun changement de stratégie.

Invariants : ne jamais fabriquer de cash/fills absents ; ne pas interpoler une
capture AE échantillonnée pour prétendre connaître chaque fill ; expliciter la
convention de coût ; résultat estimé ≠ edge démontré. Vérifier identité net/brut,
cas zéro fill, frais seuls, latent et réalisé, données absentes, pics intermédiaires.

## CAMPAIGN — protocole déterministe de validité des preuves

Nouveau modèle de campagne et machine XState à finaliser avant implémentation.
Dépendances : #56 (ou arbitrage successeur adopté), VALUATION, DIAGNOSTICS,
RETRIES et HISTORY. #56 existe déjà ; ne pas créer une seconde calibration.

Entrées gelées : runId, policyHash, versions Cloudflare, capital d'ouverture,
produits, timeframe, échéance, disponibilité des marques, couverture des bougies
éligibles et nombre de décisions/fills distincts. Mesurer la couverture des
bougies daily, pas assimiler 160 réveils horaires à 160 décisions indépendantes.

États proposés : draft → reviewed sur MODEL_REVIEWED ; reviewed → collecting
sur START_AUTHORIZED et prérequis techniques vérifiés ; collecting → invalidated
sur CONFIG_CHANGED/VERSION_CHANGED ; collecting → evaluating sur WINDOW_CLOSED ;
evaluating → operationallyValidated ou inconclusive selon gardes figées.
Un résultat « opérationnellement validé » n'est jamais un GO live ni un edge.

Effets : manifeste immuable, preuves horodatées, rapport et demande d'arbitrage.
Un redémarrage/reset/déploiement est un effet opérateur séparément autorisé,
qui préserve les données antérieures. Aucun de ces effets n'est lancé ici.

Invariants : pas de mélange de campagnes ; pas de prolongation décidée après
observation du résultat pour obtenir un gain ; seuils et taille minimale de
l'échantillon justifiés et figés avant START_AUTHORIZED ; données insuffisantes
→ inconclusive ; alertes gelées existantes conservées ; production-launch et
live-preflight restent souverains. Vérifier changement de version, trou de
collecte, snapshot périmé, échantillonnage AE, zéro/deux fills et rejeu identique.
