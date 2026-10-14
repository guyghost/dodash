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
