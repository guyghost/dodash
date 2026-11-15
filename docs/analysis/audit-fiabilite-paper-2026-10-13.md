# Audit de fiabilité paper — 13 octobre 2026

## Verdict et périmètre

**Premier lot recommandé : sécurité temporelle des cycles repris.** La garde
de fraîcheur accepte encore une bougie expirée à l'instant de reprise, et un
réveil de grille reprenant un ancien cycle peut être absorbé comme doublon.
Ces défauts doivent être modélisés avant toute correction. La réussite des
tests existants ne suffit pas à valider ces invariants temporels.

Audit du code local au SHA `0c69b69de31dc5cc78566cf4daa2a15c38676111`, des
modèles, des tests et des captures archivées. Aucun appel Cloudflare, aucun
ordre, aucune modification de configuration, aucune activation ni déploiement.
L'état actuel de production n'est donc **pas vérifié**.

Les analyses, scripts et preuves des 7–8 octobre étaient non suivis par Git
au début de l'audit. Ils ont été consultés comme pièces locales, sans être
modifiés ni présentés comme preuves versionnées du SHA ci-dessus.

## 1. Constatations priorisées

### F1 — Critique : fraîcheur jugée au déclenchement, pas à la reprise

- **Code confirmé :** `models/trading-cycle.machine.ts:57–61` compare
  `candleClosedAt` à `context.triggeredAt`.
- `apps/agent/src/interpreter.ts:290–325` refetche avec le `triggeredAt`
  original et émet `MARKET_DATA_READY` sans instant de réception/évaluation.
- `apps/agent/src/state.ts:276–299` conserve cet instant pour un cycle repris.
- **Reproduction locale :** bougie close à 00:00, cycle déclenché à 00:01:05,
  reprise supposée à 02:01:01, limite de 7 200 000 ms. Après un 429 puis
  `RETRY_TIMER_ELAPSED`, `MARKET_DATA_READY` conduit à `computingIndicators`,
  alors que l'âge réel serait de 7 261 000 ms.
- La machine ne reçoit pas l'heure de reprise : ce diagnostic démontre le
  défaut du contrat, pas un fetch réseau réel à 02:01:01.
- **Observation historique compatible :** ETH le 30 septembre, décrite dans
  `analyse-paper-session-2026-10-07.md:120–131`.
- **Impact :** décisions potentiellement hors fenêtre ; violation de
  l'invariant 4 de `models/market-retry-schedule.md`.

### F2 — Important : réveil de grille absorbé lors d'une reprise

- **Chaîne confirmée par lecture :** `resolveCycleInvocation` reprend l'ancien
  `cycleId` si la machine n'est pas `waiting`. Dans `runTradingCycle`,
  `alarmTriggered` démarre à `false`. Si la reprise se termine et revient à
  `waiting`, le même appel avec `triggerAlarm=true` émet `ALARM_FIRED` avec
  l'ancien identifiant.
- La garde `isNewAlarm` refuse ce même identifiant et
  `recordDuplicateAlarm` enregistre `DUPLICATE_ALARM`.
- **Sources :** `apps/agent/src/state.ts:276–299`,
  `apps/agent/src/interpreter.ts:123,174–187`,
  `models/trading-cycle.machine.ts:51–52,479–492`.
- **Impact :** un ancien cycle est repris, mais le réveil courant ne démarre
  pas son propre cycle ; diagnostic pollué par un doublon interne.
- Ce mécanisme est aussi consigné dans
  `models/market-retry-schedule.review.md:54–59`. Aucun test d'intégration du
  callback Durable Object n'a été exécuté pour cette constatation.

### F3 — Important : disponibilité marché encore insuffisamment prouvée

- Le rapport du 7 octobre décrit environ 60 % de fetchs limités et seulement
  3 décisions daily valides sur 18 jours-produit **avant** le correctif.
- La capture locale du 8 octobre montre 10 lignes de cycle, 4 `RATE_LIMITED`,
  aucun retry no-op et deux décisions à 00:02. Ce petit échantillon ne prouve
  pas une couverture durable.
- Les journaux du Worker marché montrent des **429 sur les bougies**, sans
  `Retry-After`, le 7 octobre à 22:01 pour BTC et ETH. Attribuer tout le problème
  au ticker n'est donc pas justifié.
- Le ticker possède **déjà un cache par produit** dans
  `apps/mcp-market-data/src/coinbase.ts:357–414`. Un nouveau cache ne constitue
  pas à lui seul une correction démontrée ; collecter d'abord les hits/misses,
  les statuts et les fenêtres demandées.
- **Suite :** mesurer séparément bougies/ticker et couverture des décisions
  après correction temporelle, sans contourner le fournisseur ni modifier
  implicitement la politique de trading.

### F4 — Important : couverture de test du shell d'alarme incomplète

Les tests de `resolveRetryWake` et de l'interpréteur couvrent alignement,
réarmement borné et attente persistée. La recherche dans `apps/agent/test`
ne trouve pas de test direct de `TradingAgent.retryTick` et de son routage.
Les tests purs ne démontrent pas le comportement combiné SDK/SQLite/callback
après redémarrage ou avec deux produits concurrents.

### F5 — Limite de mesure : prix daily souvent stale

Le rapport du 7 octobre compte 6 valorisations `fresh`, 474 `stale` et 12
`unavailable`. Un close daily évalué avec un seuil de 2 h devient stale
pendant l'essentiel de la journée par construction. Les marks évitent le
repli trompeur au coût, mais ne prouvent pas une mesure intrajournalière du
risque. Une fraîcheur de valorisation distincte constitue un lot séparé,
avec modèle et critères propres ; ne pas augmenter le seuil de décision
pour masquer ce problème.

## 2. Éléments déjà présents — ne pas les réimplémenter

| Élément | Code et tests | Preuve opérationnelle / limite |
| --- | --- | --- |
| Alignement des retries à la seconde | `alignRetryInstant`, tests de `market-retry-schedule` | Capture locale du 8 octobre : aucun retry no-op sur la courte fenêtre |
| Réarmement anticipé borné | `resolveRetryWake`, `TradingAgent.retryTick` | Reprise BTC/ETH observée ; callback DO non testé directement |
| Retry ciblé par produit | `runPortfolio(false, productId)` | Chemin partagé `runProductCycle` ; pas de preuve exhaustive d'isolation runtime |
| Mark paper daté et risque journalier | `resolvePaperDailyRisk`, tests de modèle et runtime | Rapport du 7 octobre : équité au mark, pas 10 000 au coût |
| Cache 6 h des bougies closes | `CLOSED_WINDOW_CACHE_TTL_SECONDS`, tests Worker | Les 429 persistent sur certaines requêtes de bougies |
| Grille alignée et décision manquée | `cycle-schedule`, tests et appel avec `completedAt: Date.now()` | Grille observée dans le rapport ; trou horaire du 1er octobre inexpliqué |
| Intention d'ordre avant soumission | Machine et tests de cycle/exécution/réconciliation | Aucun nouvel essai de crash du DO réalisé pendant cet audit |

Les captures `evidence-paper-2026-10-08/deployments.json` indiquent un
redéploiement agent et marché le 7 octobre vers 22:39 UTC. Il ne faut donc
pas extrapoler le constat « aucun déploiement depuis le 28 septembre » du
rapport précédent à toute la période suivante.

## 3. Vérifications locales exécutées

| Commande | Résultat |
| --- | --- |
| `npm test --prefix models` | 40 fichiers, 488 tests passent |
| `npm test --prefix apps/agent` | 28 fichiers, 295 tests passent |
| `npm test --prefix apps/mcp-market-data` | 3 fichiers, 16 tests passent |
| `npm run check --prefix models` | Passe |
| `npm run check --prefix apps/agent` | Passe |
| `npm run check --prefix apps/mcp-market-data` | Passe |
| `npm run build --prefix models` | Passe ; utilisé pour la reproduction XState |

Total : **799 tests passent**. Ce n'est pas un gate complet de release :
aucun build Worker, audit de dépendances, test navigateur ou contrôle live
n'est revendiqué. La première commande de reproduction lancée à la racine
ne résolvait pas `xstate` ; relancée depuis `models/`, elle a réussi.

Reproduction de F1 après build, depuis `models/` :

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createActor } from 'xstate';
import { tradingCycleMachine } from './dist/trading-cycle.machine.js';
const close = Date.UTC(2026, 8, 30);
const resumedAt = close + 7_261_000;
const actor = createActor(tradingCycleMachine, { input: {
  agentId: 'audit-paper', strategyIds: ['rsi-reversion'],
  maxMarketStalenessMs: 7_200_000,
} }).start();
for (const event of [
  { type: 'START_REQUESTED', permissions: { canControl: true, canTrade: true } },
  { type: 'SCHEDULE_SUCCEEDED', nextWakeAt: close + 65_000 },
  { type: 'ALARM_FIRED', cycleId: 'audit-resumed', triggeredAt: close + 65_000 },
  { type: 'ACCOUNT_RECONCILED', snapshotId: 'account-audit' },
  { type: 'MARKET_DATA_FAILED', error: {
    phase: 'market-data', code: 'RATE_LIMITED', retryable: true,
  } },
  { type: 'RETRY_TIMER_ELAPSED' },
  { type: 'MARKET_DATA_READY', snapshotId: 'market-audit', candleClosedAt: close },
]) actor.send(event);
assert.equal(actor.getSnapshot().value, 'computingIndicators');
console.log({ ageAtResumeMs: resumedAt - close, phase: actor.getSnapshot().value });
actor.stop();
JS
```

Cette assertion caractérise le défaut actuel ; elle n'est pas un test de
non-régression validant la sécurité souhaitée.

## 4. Premier lot à modéliser — proposition, pas contrat normatif

Suivre **Model → Review → Implement → Verify**, en deux incréments distincts :

1. **F1 : fraîcheur à la réception/évaluation.** Expliciter dans `models/`
   l'instant porté par l'événement marché, sa validation, l'échéance d'origine
   et le comportement des cycles persistés legacy. La machine, jamais le
   shell ou un LLM, décide d'accepter ou de rejeter les données.
2. **F2 : reprise versus nouveau réveil.** Modéliser l'identité de chaque
   invocation et le traitement du réveil courant après clôture d'une reprise,
   sans lancer deux décisions sur la même bougie.

Critères à figer dans les modèles avant implémentation :

- Données reçues après la limite : aucun calcul de stratégie ni ordre.
- Frontières `deadline − 1 ms`, `deadline`, `deadline + 1 ms` explicites.
- Reprise au-delà de minuit : aucun transfert implicite vers une autre bougie.
- Stop/kill prioritaires ; budget et délais de retry inchangés.
- Réveil courant non perdu, aucun doublon d'ordre/décision, isolation produit.
- `decision.missed` dédupliqué sur la bougie originale à la clôture effective.
- Tests du modèle, de l'interpréteur restauré et du callback DO requis.

Déploiement et nouveau segment paper nécessitent une autorisation distincte.

## 5. Incidence sur le chantier rentabilité

Le modèle `ema-signal-decoupling.md` ferme la recherche d'edge V1. Toutefois,
le dépôt contient déjà un candidat plus récent : **P7 / `TARGET_EXPOSURE`**,
modèle normatif du 10 octobre, implémentation paper et test de cohérence.
La procédure de bascule du runbook est explicitement **non exécutée**.

La sélection de P7 parmi huit politiques sur un historique déjà consulté et
sa cohérence avec le simulateur ne démontrent pas un edge OOS. Son drawdown
historique d'environ 46–47 % reste substantiel. Après fiabilisation, examiner
ce candidat et pré-enregistrer une validation prospective indépendante plutôt
que créer d'emblée une stratégie supplémentaire ou reprendre les axes V1 fermés.
La campagne funding v2 conserve ses seuils et son verdict unique, sans retouche.
