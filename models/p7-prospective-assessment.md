# P7 — assesseur local en lecture seule

## Model

Checkpoints fixes J30/J90/J180 ; jamais un horizon choisi selon le résultat.
XState waiting → reported (J30/J90) ou invalid/inconclusive/favorable/unfavorable
(J180), sur faits de registre revalidés par le shell SQLite. Aucun événement
de démarrage ni changement de stratégie. Sortie explicitement synthétique :
`syntheticVerdict`, `prospectiveVerdict=null`, aucune qualification réelle.

J30/J90 lisent le préfixe du journal à la date fixée, même si le rapport est
généré plus tard. J180 peut intégrer le reçu FINAL enregistré après T1 : son
asOf reste T1 et ses books sont pré-T1. Aucun prix post-T1 admis. Les preuves
de suivi et l'inventaire ne sont pas remplacés par le dernier mark favorable.

Comptage calendrier : 2×jours slots daily, jours×24 slots horaires, inconnus
et refus inclus. Attente daily absente ou inscrite après close+2 h est un
défaut de preuve ; pas un MISSED supposé. ≥99 % d'admissions fraîches et
≥99 % de marks disponibles P7 et B&H séparément ; gaps historiques ≤2 h,
100 % de slots daily terminaux, zéro réponse en vol. Event marks ne comptent
jamais pour la couverture horaire. B&H initial complet et tous les marks
après fill disponibles sont requis ; FINAL disponible à J180 et inventaire
inchangé. Les modes V8/V9 et le binding local sont explicitement requis.

Priorité : invariant invalide → INVALID_CAMPAIGN ; DD P7 observé >50 % →
UNFAVORABLE conservé même après remontée ; arrêt opérateur/proof gap ou preuve
incomplète → INCONCLUSIVE. Sinon à J180, rendement final net simulé >0 et
DD ≤50 % → FAVORABLE, sinon UNFAVORABLE. À J30/J90, chiffres descriptifs
uniquement, pas de verdict économique intermédiaire.

Comparer cash 20 000 $/0 % et B&H, rapporter sous-performance et coûts réalisés
simulés. Dernier mark descriptif daté à J30/J90 ; à J180, valeur finale seulement,
jamais un dernier mark antérieur substitué. DD sampled inclut les observations
P7 conservées, notamment après-fill, sans prétendre mesurer l'intraday continu.

## Review préalable / limites

Accepté pour lecture seule locale. Le core ne signe ni n'authentifie une venue ;
le shell revalide le journal avant de fournir le snapshot et lie le rapport
à séquence/hash. Exports/anchors distants, source réelle/préflight, assesseur
de campagne réelle et automatisation des checkpoints restent bloquants.
Même une qualification synthétique locale ne démontre ni rentabilité future,
ni collecte prospective, ni permission GO/live. Aucune écriture distante ou push.

## Review de livraison

10 tests purs + 3 SQLite : échéances imposées, J30/J90 descriptifs, qualification
synthétique positive, seuils admissions/marks 99 % et gap exactement 2 h,
rendement strictement positif et DD exactement 50 %, invariant invalide,
DD >50 % sticky, arrêt opérateur, FINAL/slots inconnus et hash J30 inchangé
après diagnostic ultérieur. Rapports en lecture seule, génération sans effet
de checkpoint, export ou démarrage.

Le shell vérifie le journal entier, même après un checkpoint historique,
avant de transmettre son préfixe au core. Source sequence/hash et hash de
rapport ne sont pas des signatures ; génération datée hors hash économique.
Économies principales null si clôture conjointe incomplète ; cash de référence
analytique distingué des marks inconnus. Exposition moyenne échantillonnée,
non pondérée temporellement et non preuve intraday. Aucune nouvelle dépendance.
