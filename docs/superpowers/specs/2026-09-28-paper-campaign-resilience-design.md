# Résilience de la campagne paper — conception du 28 septembre 2026

Source factuelle : `docs/analysis/analyse-paper-session-2026-09-28.md`.
Périmètre validé par l'opérateur : quatre lots locaux (Model → Review →
Implement → Verify) puis déploiement des Workers paper avec les configurations
`wrangler.paper.jsonc`. Aucune activation live ; aucun changement de politique
de trading (`ONE_DAY`, 3 600 s, fraîcheur 2 h, stratégies, sizing).

## Lot A — fenêtre de risque journalier paper robuste aux pannes marché

Problème : l'équité marquée qui ouvre et alimente `dailyRiskWindow` en paper
retombe sur `averagePrice` (coût d'acquisition) après deux échecs marché
consécutifs, et la phase `reconcilingAccount` ré-ancre la fenêtre sur
`cash + quantité × averagePrice` à chaque cycle. `dailyPnl` (entrée du garde
`DAILY_LOSS_LIMIT`) est donc faux dès qu'une position est ouverte.

Décision :

- La seule source d'équité marquée paper est `projectPaperValuation` avec le
  dernier mark accepté (`lastPaperMark`, DAO #62), daté et qualifié.
- Nouveau contrat pur `resolvePaperDailyRisk(current, currentDailyPnl, now,
  valuation)` dans `models/daily-risk.ts` : si la valorisation a une équité
  numérique (`fresh` ou `stale`), la fenêtre est résolue par
  `resolveDailyRiskWindow` ; sinon (`unavailable`, position ouverte sans mark)
  la fenêtre et `dailyPnl` courants sont **portés inchangés**. Une fenêtre UTC
  ne s'ouvre jamais sur une équité au coût.
- En paper, `reconcilingAccount`, `ORDER_CONFIRMED`, `NO_SELL_NEEDED` et
  `PROTECTION_FAILED` ne ré-ancrent plus la fenêtre dans l'interpréteur ; la
  fenêtre est résolue par le runtime avant et après le cycle avec le mark. Le
  mark après fill est le mark accepté du cycle appliqué au portefeuille post-fill.
- Live et perp : inchangés (fenêtre réconciliée depuis le compte réel).
- Migration : une instance déployée avec position et sans `lastPaperMark`
  porte sa fenêtre héritée jusqu'au premier snapshot marché accepté.

## Lot B — cache marché aligné sur l'immuabilité, 429 observables

- `CoinbaseMarketData.getCandles` : quand la fenêtre demandée est entièrement
  close (`(end + durée) ≤ now`), le snapshot est immuable et mis en cache avec
  `CLOSED_WINDOW_CACHE_TTL_SECONDS = 21 600` (6 h). Sinon, règle actuelle
  (`min(TTL configuré, durée − 1)`). Ticker : inchangé.
- Le Worker marché journalise `coinbase_rate_limited` (`kind`, `retryAfterSeconds`)
  et renvoie `Retry-After` sur ses réponses 429 internes.
- L'agent lit `Retry-After` et le porte dans `WorkflowError.retryAfterMs`
  (champ diagnostic optionnel, comme `detail`) ; aucune garde ne le lit.

## Lot C — retries marché planifiés et persistants

Le modèle `agent-runtime.md` dit déjà : « les phases `retrying*` ne déclenchent
aucun effet immédiatement ; un réveil ultérieur émet `RETRY_TIMER_ELAPSED` ».
L'interpréteur viole cette règle. Correction :

- Planificateur pur `planMarketRetry` (`models/market-retry-schedule.ts`) :
  délais par tentative `[60 s, 300 s, 900 s]`, `Retry-After` honoré s'il est
  plus long (plafond 900 s), échéance `deadlineAt = decisionCandleClosedAt +
  maxMarketStalenessMs` où `decisionCandleClosedAt = floor(T / D) × D`. Résultat :
  `{ kind: "schedule", nextRetryAt, attempt }` ou `{ kind: "exhausted", reason:
  "DEADLINE" | "BUDGET" | "NOT_RETRYABLE" }`.
- Effets : en `retryingMarketData`, l'interpréteur persiste
  `artifacts.marketRetry = { attempt, nextRetryAt, deadlineAt, errorCode }`
  (checkpoint) **puis** programme une alarme ponctuelle `retryTick` ; il ne
  renvoie `RETRY_TIMER_ELAPSED` que lorsque `now ≥ nextRetryAt`. Le réveil
  horaire partagé reprend aussi un cycle en attente (comportement existant).
- Quand aucun retry ne peut aboutir avant l'échéance, l'effet marché qualifie
  l'erreur `retryable: false` (classification, pas décision) : le cycle échoue
  en un seul appel, sans les trois refetch immédiats actuels.
- Stop/kill : priorité inchangée (garde `shutdownRequested`). Une alarme de
  retry orpheline est un no-op (`triggerAlarm=false`, machine hors retry).
- Portefeuille : chaque produit porte son propre `marketRetry` ; l'alarme
  ponctuelle est nommée par produit ; l'alarme partagée n'est pas touchée (INV-P3).

## Lot D — grille horaire et alerte de décision manquée

- `cycle-schedule.ts` : `resolveCycleSchedule(intervalSeconds)` renvoie
  `{ kind: "cron", expression }` quand l'intervalle est un multiple de 60 s qui
  divise 86 400 s (décalage d'une minute au-delà de 600 s pour laisser Coinbase
  publier la bougie close), sinon `{ kind: "interval" }` (comportement actuel).
  `AgentScheduleState` gagne `kind` et `expression` ; un état legacy sans `kind`
  est ré-armé au prochain passage en `scheduling`.
- Télémétrie : nouvel événement `decision.missed` (schéma 3, même projection AE,
  `outcome = DECISION_WINDOW_MISSED`), émis une fois par bougie de décision
  lorsqu'un cycle se termine après l'échéance sans décision enregistrée pour la
  bougie attendue. Dédoublonné par `lastMissedDecisionCandleClosedAt` persisté.
  Classe opérateur `DECISION_WINDOW_MISSED`. Les alertes live gelées ne changent pas.

## Hors périmètre

Politique de trading, cadence, garde ticker (#56), dépendances externes
(clé Coinbase), gouvernance DAO. La série 429 ≥ 6 h reste une requête AE de
supervision, documentée, non implémentée dans le Durable Object.

## Vérification

Tests de modèles (`models/*.test.ts`), tests agent (`vitest`), tests Worker
marché, `pnpm check`, `pnpm lint`, `pnpm build`. Puis déploiement paper des
quatre Workers, `/health`, `wrangler tail` sur trois cycles, capture AE du
premier événement `schemaVersion 3` et note de segment de campagne dans le runbook.
