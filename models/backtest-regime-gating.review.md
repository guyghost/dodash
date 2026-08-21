# Backtest Regime Gating — Revue

Revue de [backtest-regime-gating.md](./backtest-regime-gating.md) selon la
grille Model → Review → Implement → Verify.

## Grille de couverture

| Cas | Couvert par | Verdict |
|---|---|---|
| Nominal : régime actif, signal permis | §3.4, IG2 | ✅ signal transmis |
| Nominal : régime actif, signal interdit | §3.4, IG2 | ✅ signal écarté, compté |
| Warm-up du filtre (minObservations/streak) | §3.4 (« warmingUp »), IG1 | ✅ tous les signaux filtrés |
| Bougie sans EMAs valides (début de série) | §3.1 (« ne rien envoyer ») | ✅ pas d'observation, filtrage conservé |
| Politique absente | §4 | ✅ rétro-compatible, `regimeGating: null` (IG6) |
| Politique invalide | §4 | ✅ `INVALID_BACKTEST_CONFIG` avant itération |
| Filtre `failed` (observation invalide) | §3.2, IG5 | ✅ `REGIME_FILTER_FAILURE`, pas de reprise |
| Filtre déjà terminal (`stopped`) | §7 (« en état non-terminal ») | ✅ `STOP_REQUESTED` envoyé une seule fois |
| Position ouverte pendant changement de régime | §1, IG3 | ✅ jamais liquidée par le gating |
| Fin de replay | §3, §7 | ✅ `STOP_REQUESTED (SESSION_END)` |
| Permissions manquantes dans la table | Délégué à `resolveRegimePermission` (ok:false) | ✅ traité comme deny (IG2) |
| Stratégie inconnue de la table | Deny par défaut du modèle | ✅ traité comme deny |
| Doublon / régression de timestamp | IG4 + validation `regimeFilterMachine` | ✅ impossible par construction |
| Retry / annulation opérateur | Hors périmètre replay (batch) | ✅ N/A — `STOP_REQUESTED` uniquement en fin |

## Transitions implicites recherchées

- « En cas d'échec du filtre, continuer sans gating » → **interdit** (IG5).
- « Si warmingUp trop long, forcer un régime » → **interdit** (le filtre
  décide seul ; le replay ne force rien).
- « Deviner le régime depuis les EMAs côté replay » → **interdit** (IG7 ;
  classification exclusivement dans `classifyRegimeObservation`).

## Points vérifiés

1. La source des permissions est unique (`DEFAULT_REGIME_PERMISSIONS`) ;
   le replay n'a aucune table locale.
2. Les diagnostics de confiance restent calculés avant gating → les
   études de calibration existantes restent comparables.
3. Le protocole n'ajoute aucun état nouveau : tous les états traversés
   appartiennent à `regimeFilterMachine`.
4. IG6 garantit que les résultats historiques (bearish/bullish déjà
   produits) restent reproductibles sans flag.

## Décision

Modèle validé. Aucun bloceur. Deux risques acceptés :

- **R1** (faible) : la durée de warm-up du filtre réduit le nombre de
  bougies tradées — attendu et conforme au deny-par-défaut.
- **R2** (faible) : le filtre utilise les EMAs de la bougie de décision
  courante (pas de lookahead : le snapshot est calculé sur `history`
  clos à l'index courant).

## Vérification (mesures, BTC-USD ONE_DAY, fixed 300/600)

Tests : 65/65 (`@dodash/backtest`), 170/170 (`@dodash/models`), typecheck OK.

| Période | Config | Ensemble | PF | maxDD | Trades |
|---|---|---|---|---|---|
| Bear 2025-2026 | baseline | +3,70 % | 1,77 | 3,29 % | 107 |
| Bear 2025-2026 | régime 100/5/3 | +3,63 % | 1,74 | 3,37 % | 90 |
| Bull 2023-2024 | baseline | -0,38 % | 0,86 | 2,60 % | 52 |
| Bull 2023-2024 | régime 100/5/3 | -0,17 % | 0,93 | 2,54 % | 63 |
| Bull 2023-2024 | régime 50/5/3 | -0,65 % | — | 2,38 % | 65 |

Lecture :

- Bear : gating quasi neutre — rsi-reversion bit-identique (permis en
  RANGE/BEARISH), bruit ema-cross supprimé (13 → 0 trades).
- Bull : amélioration marginale ; le filtre classe l'année en
  BEARISH/RANGE l'essentiel du temps (EMA 100 bps trop myope sur
  ONE_DAY). Le frein principal en bull reste les protective exits,
  pas les permissions.
- Sensibilité : 50 bps dégrade (whipsaw de régime). Défaut 100/5/3
  conservé.
