# Backtest Regime Gating — Modèle

> Source de vérité pour l'intégration du filtre de régime
> ([regime-filter.md](./regime-filter.md)) dans le replay backtest.
> Le replay est un **consommateur** de la machine `regimeFilterMachine` :
> il ne définit aucune nouvelle transition, il orchestre le modèle existant.

## 1. Objectif

Empêcher les stratégies de s'exécuter dans des régimes où les backtests
montrent qu'elles détruisent de la valeur (ex. `breakout` en BEARISH,
`rsi-reversion` en BULLISH). Le gating filtre les **signaux d'entrée** ;
il ne gère jamais les sorties (déléguées aux exits existants :
protective orders, signaux inverses, fin de replay).

## 2. Éléments réutilisés (sans redéfinition)

| Élément | Source | Rôle dans le replay |
|---|---|---|
| `regimeFilterMachine` | `models/regime-filter.machine.ts` | Acteur unique par replay, piloté par `CANDLE_CLOSED` |
| `RegimeFilterPolicy` | `models/regime-filter.types.ts` | Politique passée via `BacktestConfig.regimeFilter` |
| `resolveRegimePermission` | `models/regime-filter.ts` | Décision allow/deny par (régime, strategyId) |
| `DEFAULT_REGIME_PERMISSIONS` | `models/regime-filter.ts` | Table de permissions (BULLISH: ema-cross+breakout ; BEARISH/RANGE: rsi-reversion) |

Aucune permission n'est définie côté replay : le replay consomme la table
du modèle. Deny par défaut, sans exception locale.

## 3. Protocole d'orchestration (par bougie de décision)

Pour chaque bougie de décision (index ≥ warmup) disposant d'un snapshot
d'indicateurs :

1. **Nourrir le filtre** — si `emaFast > 0`, `emaSlow > 0`, finies :
   envoyer `CANDLE_CLOSED { start: snapshot.candleClosedAt, emaFast, emaSlow }`.
   Sinon, **ne rien envoyer** (bougie sans observation : le filtre reste
   dans son état courant ; aucun régime actif possible sans observation
   valide, donc signaux filtrés).
2. **Vérifier la santé du filtre** — si l'acteur est `failed`, le replay
   retourne `REGIME_FILTER_FAILURE` (erreur explicite, jamais de
   dégradation silencieuse vers « sans filtre »).
3. **Évaluer les signaux** — inchangé : `strategies.evaluateAll(...)` sur
   l'historique complet.
4. **Filtrer par permission** — un signal n'atteint l'allocation que si le
   filtre est dans un état `regimeX` actif **et** que
   `resolveRegimePermission(regime, strategyId)` retourne
   `{ ok: true, value: true }`. Tout autre cas (warmingUp, `ok: false`,
   `value: false`) → signal écarté (compté, jamais loggué comme erreur).
5. **Allouer** — `allocateSignals` reçoit uniquement les signaux filtrés.
   Le sizing, le risk check et le broker sont inchangés.

En fin de replay : `STOP_REQUESTED { reason: "SESSION_END" }`.

## 4. Config et rétro-compatibilité

`BacktestConfig.regimeFilter?: RegimeFilterPolicy`.

- Absent → comportement strictement identique à aujourd'hui (aucun acteur
  créé, aucun signal filtré, `regimeGating: null` dans le résultat).
- Présent mais invalide (`isValidRegimeFilterPolicy === false`) →
  `INVALID_BACKTEST_CONFIG` avant toute itération (l'acteur du filtre
  passerait de toute façon en `failed` ; on échoue tôt).

## 5. Observabilité

`BacktestResult.regimeGating` (null si pas de filtre) :

| Champ | Signification |
|---|---|
| `policy` | Politique appliquée |
| `finalRegime` | Régime final (`null` si jamais sorti de warmingUp) |
| `observationsFed` | Observations envoyées au filtre |
| `signalsPassed` / `signalsFiltered` | Compteurs de gating (entrées) |
| `deniedByStrategy` | Signaux filtrés par strategyId |

Les diagnostics de signaux existants restent calculés **avant** gating
(signaux émis par les stratégies) : la comparabilité des diagnostics de
confiance est préservée.

## 6. Invariants

- **IG1** — Aucun signal n'atteint `allocateSignals` si le filtre n'est pas
  dans un état `regimeX` actif.
- **IG2** — Aucun signal n'atteint `allocateSignals` si
  `resolveRegimePermission` ne retourne pas `{ ok: true, value: true }`.
- **IG3** — Le gating ne modifie ni ne clôt jamais une position ouverte
  (il ne filtre que les entrées).
- **IG4** — Au plus une observation par bougie de décision, toujours avec
  `start` strictement croissant et EMAs finies positives.
- **IG5** — Acteur `failed` → `REGIME_FILTER_FAILURE` immédiat ; jamais de
  reprise implicite ni de poursuite sans filtre.
- **IG6** — Sans `regimeFilter` dans la config, le résultat est
  bit-identique au comportement actuel (`regimeGating: null`).
- **IG7** — Le replay ne contient aucune logique de classification ni de
  permission : uniquement des appels au modèle.

## 7. Événements et effets de bord

| Événement envoyé au filtre | Moment | Effet |
|---|---|---|
| `CANDLE_CLOSED` | Bougie de décision avec EMAs valides | Transition d'état du filtre (gérée par la machine) |
| `STOP_REQUESTED (SESSION_END)` | Fin de replay (enfin non-terminal) | Passage en `stopped` |

Effets de bord du gating : aucun ordre, aucune mutation de portfolio ;
seule la composition du tableau de signaux passés à l'allocation change.
