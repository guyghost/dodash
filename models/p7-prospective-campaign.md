# P7 — campagne prospective shadow, 180 jours

Statut : **NORMATIF, approuvé et gelé par l'opérateur le 14 octobre 2026**.
Horizon, critères et conventions approuvés avant toute collecte prospective.
Pas de démarrage, appel réseau, nouveau Worker, migration ou ordre autorisé.

## 1. Objectif / hypothèses

Observer P7 sur des données futures, avec des prix accessibles **après** la
décision, et séparer fonctionnement technique et résultat économique simulé.
Le résultat `SENSITIVE_TO_ASSUMPTIONS` historique n'est pas remplacé ou effacé.

- Politique `target-exposure` existante, paramètres et risques paper inchangés.
- BTC-USD et ETH-USD **spot**, deux créneaux de 10 000 $, sans levier, cash à
  0 %, pas de dépôt/retrait/transfert entre créneaux. Aucun actif perp substitué.
- Portefeuille shadow propre : ne pas rejouer les quantités du bot sur un
  portefeuille qui divergerait après les premiers fills aux prix observés.
- Pas d'argent réel, clé exchange, funding, ordre live ou transition pilotée
  par LLM. L'étude ne modifie pas le paper actuel.

## 2. Pourquoi une mesure distincte est requise

`apps/agent/src/interpreter.ts` utilise le dernier close pour le sizing,
le risque et la soumission paper, et transmet `triggeredAt` à l'exécution.
`submitPaperOrder` applique ensuite frais/slippage configurés à ce close.
Ce fill ne prouve pas un prix disponible après la décision.

Le ticker Advanced existant expose un last et une heure de fetch (`observedAt`
en secondes), pas un carnet, une profondeur ou un horodatage de marché amont.
La télémétrie v4 mesure l'admission, mais Analytics Engine reste échantillonné.
Elle ne suffit pas à prouver les absences ni la complétude d'une campagne.

## 3. Pré-enregistrement / préflight

Avant toute observation économique future, commiter un manifest contenant :

- campaignId, SHA politique/code/protocole/config et fingerprints des outils ;
- T0 **futur**, minuit UTC, et T1 = T0 + 180 jours, fin exclusive ;
- profil de source spot explicite (venue, endpoints bougies/carnet, unités,
  horodatages et preuve de fraîcheur), choisi **après** le diagnostic ;
- cadence, coûts simulés, benchmarks, seuils, propriétaire et procédures arrêt ;
- version et export du ledger durable, essais de reprise et collecte bornée ;
- preuve paper-only et autorisation opérateur propre au démarrage.

Le profil peut utiliser plusieurs endpoints de la **même venue/instrument**
si le manifest le déclare. Aucun fallback silencieux ni changement de profil
pendant la campagne. Perp, source, sizing ou règle de risque différents exigent
une nouvelle étude ; ne pas agréger les segments comme une campagne intacte.

Les données avant T0 servent uniquement au warmup SMA/vol (240 daily closes).
Elles ne produisent ni rendement prospectif ni trades antidatés. Les captures
antérieures/connues ne sont jamais reclassées comme OOS.

**Bloquants actuels** : source et T0 non choisis, collector/ledger non
implémentés, preuve de fraîcheur carnet non établie, aucun déploiement autorisé.

## 4. Décision et pricing

1. Pour chaque close daily UTC attendu, inscrire une clé durable
   `(campaignId, productId, candleClosedAt)`, même si le fetch échoue.
2. Admission dans les 2 h du close selon les gardes actuelles. Le modèle,
   jamais le shell, décide `ADMITTED` ou `MISSED`. Warmup discontinu/incomplet
   n'autorise pas de calcul partiel ni bougie synthétique.
3. Calculer P7 avec les closes jusqu'à la bougie admise et le portefeuille
   shadow courant. Checkpoint de la décision et de l'intention **avant** pricing.
4. Obtenir un **nouveau** snapshot de carnet après `intentPersistedAt`, sans
   utiliser le snapshot de valorisation précédent. Garder requestedAt,
   receivedAt et sourceObservedAt distincts, toujours en ms.
5. Critères proposés pour un carnet éligible : identité correcte, bid/ask
   positifs non croisés, séquence/profondeur cohérentes, sourceObservedAt non
   nul, dans `[receivedAt - 5 s, receivedAt]`, délai fetch ≤5 s et réception
   avant close+2 h. Cache amont inconnu, timestamp absent ou âge invérifiable
   => quote conservée mais **non éligible**, jamais promue en prix exécutable.
   Un timestamp de réponse HTTP ne remplace pas une date de marché.
6. Simuler un fill complet au VWAP des asks pour BUY, bids pour SELL, sur la
   quantité déjà figée. Profondeur insuffisante => `INSUFFICIENT_DEPTH`, pas de
   fill extrapolé. Spread incorporé par le côté du carnet, pas ajouté deux fois.
7. Ajouter **60 bps de frais et 2 bps de slippage adverse**, hypothèses paper
   figées comme le modèle P7, puis utiliser le broker existant. Un achat trop
   cher est refusé sans redimensionnement ou retry sur la même décision.
8. Persister atomiquement issue, cash, position, fill simulé et coûts. Une
   reprise utilise la même intention/quote persistées, jamais un nouveau prix
   choisi après coup. Issue inconnue non résolue => suspendre le shadow.

Les frais et le slippage sont **simulés**, non mesurés sans ordres réels. Sont
observés séparément : prix/carnet, spread, profondeur, variation close→VWAP,
latences close→admission→intention→quote. Même un carnet éligible ne prouve
pas qu'une venue aurait accepté/rempli un ordre réel à ce VWAP.

## 5. Ledger et couverture

Enregistrements append-only : campagne, slots attendus, admissions/manqués,
closes et fingerprint de fenêtre, signaux/HOLD, risque/refus, intentions,
quotes (payload archivable + hash), issues, portefeuilles et marks.
Identités, versions, horodatages, fournisseur et hypothèses sur chaque fait.
Correction explicite liée à l'événement initial ; jamais écrasement d'une preuve.

Chaque slot produit a une issue terminale : `HOLD`, `RISK_REJECTED`,
`QUOTE_REJECTED`, `BROKER_REJECTED`, `SIMULATED_FILL` ou `MISSED`.
`ADMITTED` seul ne signifie pas décision/fill terminé. Les erreurs et refus
restent dans les résultats ; aucun retrait de jour parce que le marché échoue.

Exporter quotidiennement ledger, numéros de séquence/contrôles de complétude et
SHA-256 dans un stockage défini au préflight. Logs/AE secondaires uniquement.
Une absence non expliquée est `UNOBSERVED`, pas un `MISSED` inventé.

## 6. Benchmarks et valorisation

Trois trajectoires prédéfinies : P7, cash 20 000 $ à 0 %, et buy-and-hold
BTC/ETH 50/50 **initial**, sans rééquilibrage ultérieur. Buy-and-hold commence
au premier carnet éligible après T0, même fenêtre maximale de 2 h ; pas de
prix rétroactif. Absence de benchmark initial complet => économie non évaluable.
Règle d'achat au budget pour le benchmark : pour chaque créneau, quantité
maximale `q` telle que `askNotional(q) × (1+s) × (1+f) ≤ 10 000 $`, arrondie
vers le bas selon la précision du profil. Utiliser le même carnet d'entrée
que celui publié pour ce slot, sans sélectionner un meilleur carnet ensuite.
Si la profondeur ne permet pas de déterminer la quantité financée par le
budget (hors reliquat d'arrondi), ne pas extrapoler : benchmark non initialisé,
économie non évaluable. Aucune nouvelle tentative après la fenêtre initiale.

Valorisation consolidée horaire, plus après fill, avec preuves de carnet
communes aux trajectoires. Proposition : valeur liquidable simulée = cash +
vente de la quantité au VWAP bid disponible, slippage/frais de sortie estimés
inclus. Ces coûts hypothétiques ne changent pas le cash du ledger et ne sont
pas retranchés une seconde fois des frais réalisés simulés.

Sans profondeur ou quote éligible, mark `UNAVAILABLE`, pas de coût d'acquisition,
de close stale promu en mark frais, de zéro ou d'interpolation. Un mark
antérieur peut être affiché daté/stale, mais ne prouve pas une limite respectée.
Le DD mesuré est **échantillonné horaire**, pas le DD intraday continu garanti.

## 7. Échéances et critères

- J30/J90 : bilans techniques fixés, chiffres économiques descriptifs seulement.
- J180 : évaluation principale sur `[T0,T1)` ; aucun choix d'une fin favorable.
- Tous les produits et jours restent inclus. Pas d'exigence de 30 trades pour
  une politique d'allocation peu active, ni multiplication de checkpoints
  économiques permettant de sélectionner une réussite.

**Qualification technique proposée**, précondition d'une interprétation :

- 100 % des slots daily réconciliés dans le ledger, zéro duplication, issue
  inconnue non résolue, cash négatif, short ou modification de manifest ;
- ≥99 % d'admissions daily fraîches sur les **360 jours-produit attendus** ;
- ≥99 % des marks horaires consolidés attendus disponibles pour P7 et B&H ;
- aucun intervalle sans mark éligible >2 h ; export complet et vérifiable.

Les seuils de quote/couverture proposés sont des exigences d'étude, pas une
modification des gardes du bot. Un défaut de preuve produit `INCONCLUSIVE`,
pas un rendement de zéro ni une preuve de perte de P7.

**Économie à J180 si techniquement qualifiée** : rendement net simulé >0 et
DD observé ≤50 % => `PROSPECTIVE_OBSERVATION_FAVORABLE`, sinon
`PROSPECTIVE_OBSERVATION_UNFAVORABLE`. Comparer rendement, DD et exposition au
cash et au B&H sans imposer que P7 batte B&H en rendement brut dans un marché
haussier. Rapporter sous-performance et coûts, pas seulement un verdict.

Aucun verdict ne se nomme VALIDATED/GO. Six mois, une trajectoire et deux
actifs ne démontrent pas un edge statistique ou une performance future.

## 8. Workflow XState et arrêt

`draft → registered → preflight → ready → observing → assessing → completed`.
États de sûreté `suspended`, `stopped`, `invalid` explicites.

Événements : `REGISTER`, `PREFLIGHT_EVIDENCE`, `START_AUTHORIZED { now }`,
`SLOT_OBSERVED`, `CHECKPOINT_DUE`, `PROOF_GAP`, `INVARIANT_BREACH`,
`STOP_REQUESTED`, `PERIOD_ENDED`, `EVIDENCE_SUBMITTED`.
Le modèle décide les transitions ; seuls des faits validés peuvent lever
le préflight. Dates source/T0 et démarrage ne viennent pas d'un LLM.

- START hors fenêtre, source inconnue ou preuve insuffisante : ne démarre pas.
- Modification politique/source/coûts ou preuve altérée : `invalid`.
- Duplication/issue inconnue/intervalle sans mark >2 h : `suspended`, aucun
  nouveau fill simulé. Une réparation de collecte n'efface pas le trou.
- DD observé >50 % ou demande opérateur : `stopped` ; levier/cash négatif :
  `invalid` (défaut comptable/logiciel, pas une preuve de perte de P7).
  Pas de liquidation réelle ni kill du bot ; diagnostic/marks peuvent continuer
  dans la fenêtre autorisée, sous un contrat distinct, sans prolongation.
- Arrêt précoce sur DD >50 % => conserver `PROSPECTIVE_OBSERVATION_UNFAVORABLE`,
  ne pas attendre une remontée pour requalifier. Invariant logiciel/comptable
  violé => `INVALID_CAMPAIGN`, pas une perte attribuée à la stratégie. Arrêt
  opérateur précoce ou problème de preuve => `INCONCLUSIVE`.
- À T1 : aucun nouveau fill ; rapport et inventaire des positions ouverts,
  valeur liquidable simulée, pas d'ordre réel de fermeture.

## 9. Plan local / commandes / tests

Stack existant TypeScript, XState v5, Vitest ; core pur dans `models/`, shell
collector distinct à décider après le diagnostic. Aucun ajout de dépendance.

```ts
type CampaignEvidence = {
  campaignId: string;
  productId: "BTC-USD" | "ETH-USD";
  candleClosedAt: number;
  receivedAt: number;
  sourceObservedAt: number | null;
}; // Faits ; les gardes pures décident, le shell transporte.
```

Ordre prévu, sous Model → Review → Implement → Verify :

1. Approuver les critères et conventions, vérifier la règle B&H/marking,
   puis commiter le modèle normatif seul avant collecte.
2. Contrat de manifest/ledger, garde quote et assesseur/XState avec tests
   synthétiques (frontières dates, 99 %, 2 h, 5 s ; null/incohérence ; reprise).
3. Collector shadow et export durable, tests de crash/idempotence/persistance.
   Choix du stockage/migration soumis à approbation séparée.
4. Dry-run local, rapports synthétiques, revue de sécurité et budget fournisseur.
5. Fournisseur/T0/manifest et déploiement/démarrage approuvés séparément.

Commandes locales prévues :

```sh
pnpm --filter @dodash/models build
pnpm --filter @dodash/models test -- p7-prospective-campaign.test.ts
pnpm check
pnpm scan:secrets
```

Toujours : preuves datées, tests avant commit, données manquantes explicites.
Demander : stockage, déploiement, source, date de départ, activation.
Jamais : secrets archivés, données synthétiques prospectives, mutation du bot,
seuils retouchés après résultats ou activation live implicite.

Critères ≥99 %, quote 5 s, marks horaires, arrêt >2 h, méthodes liquidable/B&H
et verdicts approuvés. Le protocole gelé autorise la préparation locale,
pas le collector distant ni sa collecte. Source/T0, stockage/migration,
déploiement et démarrage restent des gates opérateur séparés.

Premier incrément local : garde pure d'éligibilité d'un carnet d'exécution dans
`models/p7-prospective-quote.ts`, tests Vitest associés. Elle vérifie identité,
preuve de clock du profil, dates campagne/intention/fetch/amont, cache explicite,
séquence non régressive et niveaux ordonnés/cohérents. Une séquence inchangée
est permise si le profil fournit un timestamp de snapshot frais vérifié.
`ELIGIBLE_BOOK` signifie seulement carnet utilisable pour un pricing simulé :
la profondeur pour la quantité, le VWAP, le risque et l'idempotence du ledger
restent des validations distinctes. Aucun fill ni transition de campagne n'est
produit par cette garde. Aucun champ de source absent n'est reconstruit.
