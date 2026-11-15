# ANALYSE-DAO-37 — Performance backtest, fenêtres pluri-annuelles

**Date** : 2026-09-04 · **Branche** : `feature/dao-37-backtest-performance` · **Machine de référence** : node v22.23.1, macOS arm64, exécution locale (aucun chiffre extrapolé ; commandes reproductibles en annexe).

---

## 0. Objet

Le run BTC-USD ONE_DAY sur 5 ans (2021→2026) ne tenait pas dans une timebox de
300 s (`docs/analysis/analyse-backtest-2026-09-04.md`, §0 et §5.3), bloquant
tout test multi-régimes du runner principal. La cause suspectée — « réexécution
Prolog par bougie » — a été **mesurée avant correction** (profiling CPU +
micro-benchmarks), puis corrigée au plus près de la cause, sans toucher aux
maths : les valeurs d'indicateurs restent produites par les mêmes prédicats
Prolog. Invariant INV-27 (`models/backtest-run.md`) : snapshots strictement
identiques, `snapshotId` compris.

## 1. Cause racine mesurée

Profil CPU (`node --cpu-prof`) de la préparation 365 j (338 snapshots,
82,7 s avec profiler) — `prepareBacktestIndicators` appelle
`computeIndicators(préfixe complet)` pour chaque bougie :

| Part | Fonction (tau-prolog core) | Lecture |
|---|---|---|
| 43,1 % | `Term.search` | résolution sur des listes de longueur = préfixe |
| 9,2 % | GC | churn des listes/sessions par bougie |
| 13,5 % | `Substitution.lookup/add/apply` | résolution |
| 4,8 % | `Session.__get_next_priority` | machinerie session |
| ~4 % | `parseExpr`/`Tokenizer` | parsing des buts + consult |
| 0,1 % | `computeIndicators` (JS) | le code JS est négligeable |

Micro-benchmarks (session chaude) :

- **Plancher par but** : ~1,2–1,5 ms (machinerie query/answer), ~2,5 ms avec
  résolution `ema(n=28)` ; le batching conjonctif ne réduit rien
  (6 buts séparés = 15,6 ms ≈ 1 but conjonctif 6 variables = 15,9 ms).
- **Croissance par longueur de liste** : `ema` 2,5 ms (n=28) → 6,4 ms (n=182)
  → 13,9 ms (n=365) — les buts `ema`, `macd` (2 plis) et `atr` reçoivent le
  **préfixe complet** → coût quadratique global.
- **Session + consult par bougie** : 16,3 ms × 338 ≈ 5,5 s de gaspillage pur.
- **`trend_strength`** (fenêtre glissante 2P bornée) : 30,4 ms par but —
  intrinsèque au moteur sur cette fenêtre, **non compressible sans changer les
  valeurs** (seed ADX par fenêtre, aucune continuation bit-exacte possible).
- **`hashSnapshot`** (JSON du préfixe) : ~0,2 ms/bougie — négligeable, inchangé.
- **Courbe réelle 5 ans (avant)** : latence par snapshot de 673 ms (index 576)
  à 4 274 ms (index 1776) — pente ~2,3 ms par élément de préfixe, quadratique.

Conclusion : trois coûts mesurés et séparables — (a) réévaluations bornées par
bougie (plancher assumé, garant de la bit-exactitude), (b) plis complets par
bougie (quadratique), (c) session/consult par bougie (gaspillage pur).

## 2. Correction (mécanique d'exécution uniquement)

Documentée dans `models/backtest-run.md` §« Préparation incrémentale »
(amendement revu dans `models/backtest-run.review.md`) :

1. **Une session Prolog et un `consult` uniques** par préparation
   (`createIndicatorSeriesComputer`, `packages/indicators-prolog`).
2. **Continuation incrémentale des plis complets** : `emaFast`, `emaSlow`,
   `macd`, `atr` (et paire de signal E0/E1) sont poursuivis par les
   prédicats d'accumulation **existants** (`ema_acc`, `atr_continue`,
   `is/2` pour la soustraction MACD) : le fold gauche reprend au dernier
   accumulateur avec le seul suffixe nouveau — même chaîne d'opérations
   flottantes IEEE 754, même ordre → **bit-exact par construction**.
3. **Fenêtres glissantes bornées inchangées** (`rsi`, `trend_strength`,
   `historical_volatility`, `momentum`, `periodic_return`, `ohlcv_vwap`,
   `relative_volume`, `volume_trend`) : mêmes buts que la référence,
   réévalués par bougie ; buts partagés dans un même code
   (`evaluateBoundedIndicators`) pour exclure toute divergence future.
4. **`snapshotId` inchangé** (hachage du préfixe complet).
5. **Aucune approximation, aucun cache memoïsant** : la session est construite
   pour une configuration donnée et jetée avec elle ; l'API publique
   `computeIndicators` (live, repli du replay) est intacte.

## 3. Benchmarks avant/après

| Mesure (machine de référence) | Avant | Après | Gain |
|---|---|---|---|
| Préparation 365 j (338 snapshots) | **73,1 s** | **28,0 s** | 2,6× |
| Préparation 1 829 j (1 802 snapshots) | **3 061,8 s** (51 min) | **~165 s** | 18,6× |
| Latence/snapshot (5 ans) | 673 ms (idx 576) → 4 274 ms (idx 1776) | ~83 ms (365 j) → ~92 ms (1 829 j) | quasi constant |
| Suite CLI 365 j (fetch réseau inclus) | 76,2 s | **31,7 s** | 2,4× |
| **Run 5 ans complet (fetch inclus)** | **timeout > 300 s** | **162,1 s, exit 0** | critère < 5 min ✓ |
| Replays 4 scénarios (365 j) | ~2,9 s | ~2,9 s | inchangé |

Préparation vs exécution, par fenêtre (après correction) :

| Fenêtre | Préparation | Exécution (4 scénarios + métriques) | Total CLI (fetch inclus) |
|---|---|---|---|
| 365 j | 28,0 s (88 %) | ~2,9 s (9 %) | 31,7 s |
| 1 825 j | ~165 s (93 %) | ~3,5 s (2 %) | 162,1 s |

La préparation reste dominante ; son coût par bougie est désormais quasi
constant (fins de fenêtres bornées + `snapshotId` O(n)), la composante
quadratique a disparu (ratio 5,9× pour 5,1× les données).

## 4. Preuve de non-régression

1. **Test différentiel INV-27** (`packages/indicators-prolog/test/series-computer.test.ts`,
   6 tests) : pour chaque index, snapshot incrémental ≡ snapshot de référence
   (`computeIndicators` sur le préfixe), tous champs, `snapshotId` compris
   (`toStrictEqual`) — configs défaut, compacte, avec paire de signal EMA,
   séries jusqu'à 120 bougies, warmup aligné, config invalide rejetée.
2. **Échantillon sur données réelles 5 ans** : 8 indices (warmup, warmup+1,
   300, 700, 1100, 1500, 1800, 1828) — snapshots identiques bit-à-bit à la
   référence recalculée par préfixe.
3. **Artefacts 365 j bit-à-bit** : `baseline-365-cli.json` (run avant, fetch
   réseau réel) vs `after-365-cli.json` (run après, fetch réel) — **identiques
   octet pour octet** hors champ `generatedAt` (horodatage d'exécution) :
   PnL, trades, equity, diagnostics, métriques, empreinte dataset.
4. **Suites** : `pnpm check`, `pnpm test` (149 tests backtest+indicators dont
   6 nouveaux), `pnpm build`, `pnpm lint` — sans nouveau warning.

## 5. Points ouverts

1. **~88 ms/bougie de plancher** : dominé par `trend_strength` (30 ms),
   `ohlcv_vwap` (15 ms), `historical_volatility` (8,5 ms), `rsi` (6,6 ms) —
   les compresser exigerait des continuations **non bit-exactes** (recettes
   glissantes par différence de tête) ou une réimplémentation JS : exclu par
   INV-27 en l'état. Un run 10 ans (~3 650 bougies) passerait en ~6–7 min.
2. **Replay O(n²) résiduel** : `history = candles.slice(0, i+1)` par bougie
   dans `replayBacktest` (~2,9 s sur 365 j) — négligeable devant la
   préparation, non modifié (hors périmètre de la cause mesurée).
3. **Le repli du replay** sans snapshots préparés (chemin
   `computeIndicators` par bougie) garde le comportement quadratique — chemin
   de compatibilité live/scripts, volontairement intact.
4. Le run 5 ans donne enfin un rapport multi-régimes (benchmark buy-and-hold
   +72,36 % sur 2021→2026) ; l'analyse d'edge associée reste à faire — hors
   périmètre DAO #37 (performance).

## Annexe — reproductibilité

```bash
# Référence avant (worktree au commit 31bc713) :
node dist/cli.js --product BTC-USD --timeframe ONE_DAY --start 2025-09-01 --end 2026-09-01
# Après :
pnpm --filter @dodash/backtest build && \
  node packages/backtest/dist/cli.js --product BTC-USD --timeframe ONE_DAY \
    --start 2021-09-01 --end 2026-09-04   # ~162 s, exit 0
# Diff bit-à-bit (hors generatedAt) :
diff <(grep -v generatedAt baseline.json) <(grep -v generatedAt after.json)
# Test différentiel :
pnpm --filter @dodash/indicators-prolog test
```

Artefacts conservés hors dépôt (`/tmp/dao37/`) : datasets figés
(`dataset-365.json`, `dataset-1825.json` + empreintes SHA-256), artefacts
avant/après (CLI et offline), logs de profilage et courbes baseline
(`prep-1825-baseline.log`).
