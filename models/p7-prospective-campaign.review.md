# Revue de préparation — campagne prospective P7

Statut : **GELÉ / NON DÉMARRABLE**. Horizon, critères et contrat approuvés par
l'opérateur avant collecte, le 14 octobre 2026. Pas d'approbation
de déploiement, stockage, changement de source ou activation.

## Constats vérifiés dans le code local

- `apps/agent/src/interpreter.ts`, `submittingOrder` : prix provenant du dernier
  close et horodatage `triggeredAt` transmis au broker.
- `apps/agent/src/trading-agent.ts`, `submitPaperOrder` : fill simulé au prix
  reçu et coûts configurés, pas un prix récupéré après l'intention.
- `apps/mcp-market-data/src/coinbase.ts`, ticker : `observedAt` est l'heure
  locale de fetch, en secondes. Ce n'est pas un timestamp de carnet amont.
- `models/decision-admission-telemetry.md` : fait durable v4 par cycle, mais
  sorties AE échantillonnées ; aucun registre exhaustif multi-jour démontré.
- `models/paper-valuation.md` : seules les marques de close sont reconnues,
  et la fraîcheur est celle de décision. Ne pas requalifier en mark intraday.

## Choix de frontière proposé

Observer une trajectoire shadow indépendante ; réutiliser les fonctions pures
P7/risque/broker, mais ne pas modifier le runtime du bot ni lui attribuer
les décisions/fills shadow. Nouvelle preuve, jamais relabel des anciens fills.
Les coûts paper sont des hypothèses ; carnet/spread/latences sont des observations.
L'absence de timestamp amont fiable reste un blocage, pas un champ à inventer.

## Points de revue avant implémentation / collecte

1. Accord opérateur obtenu sur couverture 99 %, marks horaires, quote 5 s et
   suspension après >2 h sans mark, ainsi que les verdicts non-live.
2. Profil spot compatible avec horodatage/sequence/profondeur exigés. Le
   diagnostic actuel de bougies/tickers ne valide pas ce contrat de carnet.
3. Tests de taille au budget B&H et VWAP bid liquidable, frais/slippage
   appliqués une seule fois ; limites de précision du profil explicites.
4. Manifest/SHA/T0/T1 immuables avant collecte, warmup séparé ; pas de
   prolongation, changement de seuil ou choix de checkpoint favorable.
5. Ledger durable exact, atomicité fill/portefeuille, export et reprise ;
   schéma/migration et stockage restent soumis à décision séparée.
6. Toute future capture doit préserver refus, manqués et trous. Un problème
   d'ingénierie ne devient pas un verdict de perte économique de P7.

## Verify de ce lot documentaire

Lectures des producteurs et modèles existants, cohérence des unités et
distinction observé/simulé. Aucun test de capture, ledger, modèle exécutable
ou campagne réelle n'est revendiqué à ce stade. L'implémentation locale suit le gel ; aucun
résultat prospectif, frais de venue réellement payés ou SLA n'existe ici.

## Verify — premier incrément local

`models/p7-prospective-quote.ts` : garde pure, sans I/O, mutation de portefeuille
ni transition. Le scope vient du futur manifest/profil validé ; la preuve de
clock est une donnée de ce scope, pas une assertion du payload amont.

- Tests écrits avant implémentation, puis reproduction RED du contrôle de
  durée 180 jours/alignement UTC avant correction.
- 8 tests passent : identité/cache/clock, source null/future/stale, 5 s
  inclusifs, fetch après intention, deadline 2 h inclusive, fin exclusive,
  carnet vide/croisé/désordonné, quantités et séquences décimales bornées.
- Niveaux limités à 5 000 par côté ; BigInt seulement après validation de
  chaîne décimale ≤64 caractères. Aucun prix/horodatage de repli.
- Suite globale : 538 tests modèles, 313 agent, 133 backtest passent ;
  TypeScript, build global dry-run et lint ciblé passent. Aucune modification du runtime du bot.

**Accepté comme contrôle local d'évidence uniquement.** Le VWAP pour la
quantité, le ledger atomique, la machine de campagne, la valorisation, les
exports et le collector ne sont pas implémentés dans cet incrément. Source
et date de départ restent indéfinies ; la campagne ne peut pas démarrer.

## Verify — registre local et reprise

Incrément suivant : `models/p7-prospective-ledger.md` et sa revue. Le modèle
de slot XState et le store SQLite temporaire sont implémentés/testés pour
des faits `LOCAL_PREPARATION` uniquement. Issue/portefeuille atomiques,
déduplication, réouverture et perte de réponse quote testées ; aucune migration
distante. La machine globale de campagne, le pricer VWAP/profondeur, les marks,
benchmarks, exports/anchors externes et le collector restent à livrer avant
tout démarrage. La source et T0 ne sont pas choisis par cette implémentation.

## Verify — pricing et projections liquidables locales

`models/p7-prospective-pricing.md` précise le VWAP sur quantité figée et les
marks sans mutation. Core et bridge broker locaux testés ; aucune collecte,
écriture automatique de fill ou persistance de mark. Pricing validé à l'heure
injectée, revalidation transactionnelle encore requise. Les fixtures V1 ne
deviennent pas des preuves prospectives ; les autres gates restent bloquants.

## Verify — commit du pricing local

`models/p7-prospective-pricing-commit.md` : commitPricing recalcule dans la
transaction SQLite depuis la quote persistée et le portefeuille relu. Requête
sans prix client, journal V2 revalidé au replay, refus conservés et rollback
sur expiration juste avant COMMIT. V1 reste une fixture déclarée, pas une
preuve de pricing. Stockage distant et marks horaires non implémentés ; la
machine globale, B&H, source/T0 et autorisations restent bloquants.

## Verify — marks horaires et complétude locaux

Contrat : `models/p7-prospective-marks.md`. Machine XState par slot, journal
V3 atomique et replay des marks depuis preuves/portefeuilles antérieurs.
Calendrier de 4 320 heures indépendant des seuls événements reçus ; comptes
AVAILABLE/UNAVAILABLE/UNOBSERVED, heure courante séparée et gap historique
>2 h explicite. Cash/positions/versions inchangés ; pas de vente ni fill.

Ce rapport ne qualifie pas P7+B&H, ne calcule pas un verdict économique et
ne suspend pas effectivement les fills : machine globale et benchmarks
encore absents. Marks après fill/final, reprise/réparation des preuves perdues,
stockage/export distant et source/T0 restent des prérequis séparés.

## Verify — harnais de campagne et garde transactionnelle

`models/p7-prospective-campaign-safety.md` : XState local, binding synthétique
explicite, garde V5 avant nouveaux fills, refus de gate durables et replay.
Gap >2 h / reprise sans réponse => suspended ; DD échantillonné >50 % ou
arrêt local => stopped ; invariants => invalid ; T1 => aucun nouveau fill.
États sticky, aucun resume automatique ou événement START_AUTHORIZED exposé.

Après binding, les chemins V1/V2 ne peuvent plus produire de nouveaux fills.
Les vieux registres non liés restent des fixtures, pas une campagne autorisée.
RECOVER_LOCAL reste un événement explicite obligatoire au bootstrap du futur
runner ; pas de lease/timer/collector ou préflight réel livré ici. L'assesseur,
B&H, source/T0, exports et autorisations distantes restent bloquants.

## Verify — projection cash/B&H locale

`models/p7-prospective-benchmarks.md` : profil de quantité V6 figé avant T0,
sizing maximal au budget sur profondeur connue, vrai broker 60/2 bps et marks
B&H sur les preuves horaires communes. Replay en lecture seule, coverage
B&H séparée de P7 CASH ; ni fill/mark rétroactif inscrit, ni prix alternatif.

Ce n'est pas encore le stream prospectif B&H : le premier carnet indépendant
d'une décision P7 HOLD, sa persistance/machine et le profil réel restent à
implémenter/vérifier. L'absence d'initialisation complète bloque toujours
l'évaluation économique ; ce replay ne change pas la qualification de campagne.

## Verify — stream d'entrée B&H indépendant local

`models/p7-prospective-benchmark-entry.md` : XState par jambe, événements V7
avant/après I/O, premier carnet éligible figé, quantités au budget et accord
avec broker vérifiés dans transaction/replay. HOLD P7 n'empêche plus B&H,
portefeuilles P7 inchangés. Perte de réponse B&H prise en compte à RECOVER_LOCAL.

La projection préfère V7 sans fallback legacy dès l'ouverture du mode ; cette
ouverture est refusée après observation du marché initial legacy. Le collector
réel, marks B&H durables, sûreté/qualification conjointe et source/T0 restent
absents. Aucun démarrage ou réseau autorisé par ce registre synthétique.

## Verify — marks horaires conjoints durables V8

`models/p7-prospective-joint-marks.md` : même machine horaire, checkpoint et
books, deux portefeuilles relus sous verrou et deux observations atomiques.
Opt-in V8 durable ; aucun nouveau mark V3 après opt-in, aucun backfill.
La sûreté évalue les deux gaps historiques indépendants à tous les gates
existants. DD et critère d'arrêt restent ceux de P7, non ceux de B&H.
Projection B&H en mode conjoint utilise les reçus durables, pas un repricing.

Restent requis : marks after-fill/final, assesseur et qualification économique,
profil source réel, timers/leases/runner et autorisations distantes séparées.
Les stores restent SYNTHETIC_LOCAL_PREPARATION, sans preuve prospective réelle.
