# Review — Campagne d'edge funding en lecture-seule (DAO #30)

Statut : APPROUVÉ (protocole pré-enregistré, aucune correction bloquante)
Modèle : `models/funding-edge-campaign.md`
Date : 2026-09-04 — **avant toute observation de données réelles**
(INV-C1 : le SHA de ce commit précède le premier fetch dans l'historique)

Fichiers vérifiés : `packages/backtest/src/replay.ts` (application du coût
`applyFundingCost` avant le point d'équité, `fundingInputFor` suffixe
non préparé, validation longueur 1:1, gating ignoré sans
`regimeFilter`), `packages/backtest/src/suite.ts` (conventions sizing
`withTargetSignalNotional`, calibration `IDENTITY`, 3 stratégies legacy
et leurs seuils, benchmark buy-and-hold),
`packages/backtest/src/coinbase-history.ts` (pagination ≤ 350, données
complètes exigées, SHA-256 canonique), `packages/backtest/src/metrics.ts`
(`sharpe` √252, `maxDrawdown`, `EquityPoint.at`),
`packages/paper-execution/src/index.ts` (`PaperTrade.fill`),
`packages/domain/src/trading.ts` (`Fill.executedAt`),
`apps/agent/src/hyperliquid-execution.ts` (`boundedRequest` 1 MiB /
10 s, `fetchHyperliquidFundingHistory` coercition `finiteFrom` + rejet
entier, `fundingRatesForCandles` moyenne par bougie, endpoint public
sans signature),
`packages/indicators-prolog/src/engine.ts` (`FUNDING_AVG_PERIOD = 72`,
`requiredIndicatorCandles` = 28, `DEFAULT_INDICATOR_CONFIG`),
`models/funding-rate-strategy.md` §10 (la campagne y est déclarée hors
périmètre #27 et soumise à pré-enregistrement),
`models/backtest-run.md` (manifeste, provenance obligatoire),
`models/regime-filter.ts` (`DEFAULT_REGIME_PERMISSIONS` dénie
`funding-trend`), `models/backtest-run.md` / `docs/operations/` (où
vivent rapports et runbooks).

## Checklist

### Séquence pré-enregistrée (C1)
- [x] Le protocole fige fenêtres, métriques, conventions de découpage et
      seuils **avant** tout fetch : le commit 1 contient uniquement
      `models/funding-edge-campaign.md` + `.review.md`, aucun artefact de
      données. L'historique git prouvera l'antériorité.
- [x] INV-C1 rend l'anti-retouche un invariant du modèle, pas une simple
      intention de processus.
- [x] Aucun seuil de §6 n'est dérivé d'une donnée observée : 0,25 de
      Sharpe, 30 trades, 0,05 de drawdown et la grille S1–S5 sont
      justifiés a priori (bruit d'échantillon, significativité, risque).

### Lecture-seule (C2)
- [x] La campagne ne touche ni `models/regime-filter.ts`, ni
      `models/live-trading-policy.ts`, ni l'admission perp, ni aucun
      fichier de production — scripts et fixtures d'artefacts uniquement.
- [x] `funding-trend` reste déniée en runtime (`DEFAULT_REGIME_PERMISSIONS`
      inchangé, vérifié) ; le backtest l'active sans filtre de régime car
      le gating est entier sous `regimeActor !== null` (replay.ts 743 :
      `gatedSignals = signalResult.value` sinon) — comportement existant,
      non modifié, documenté §4.

### Données réelles ou rien (C3)
- [x] Fixtures de campagne persistées sous `packages/backtest/fixtures/`
      avec provenance (endpoint, fenêtre, horodatage, SHA-256) — le dépôt
      n'avait aucun répertoire de fixtures : convention créée ici,
      distincte des fixtures inline des tests unitaires.
- [x] Échec de collecte ⇒ EN ATTENTE, protocole + scripts prêts ;
      aucune donnée synthétique possible par construction (la collecte
      fail-closed rejette toute lecture hors spec — mêmes bornes que la
      couture #27 : 1 MiB, timeout 10 s, coercition, rejet entier).

### Comparabilité (INV-C5)
- [x] Même série `fundingRates` pour les 4 runs : une baseline sans coût
      serait favorisée artificiellement ; le choix contraire (coût
      partout) est le seul équitable pour un perp long-only et il est
      figé §4.
- [x] Même chemin de rejeu pour tous : **non préparé** — les snapshots
      préparés sont funding-blind (models/funding-rate-strategy.review.md,
      limite consignée) et ne peuvent pas alimenter `funding-trend` ;
      `fundingInputFor` (replay.ts) nourrit l'indicateur du suffixe 72 et
      `applyFundingCost` déduit le coût avant le point d'équité — Sharpe
      net de funding par construction, pas par post-traitement.
- [x] Sizing `TARGET_SIGNAL_NOTIONAL` uniforme (models/backtest-run.md) ;
      calibration `IDENTITY` partout ; sortie protectrice `NONE` et pas
      de filtre de régime : aucune asymétrie de gating entre runs.
- [x] Benchmark buy-and-hold conservé comme contexte, hors critères.

### Fenêtres et stabilité
- [x] Bornes alignées UTC minuit, 365 jours vérifiés (91+90+92+92) ;
      R30 = dernier mois de H12 ; folds = découpage de la courbe d'un
      rejeu causal unique — aucun re-calibrage, aucun lookahead (le rejeu
      n'utilise que le préfixe passé à chaque bougie, vérifié replay.ts).
- [x] Warm-up assumé (~72 bougies sans `fundingAvg` ; 365 − 72 ≈ 293
      jours de décision) : constaté, non ajustable — conforme à
      l'esprit INV-C1 (on ne rallonge pas la fenêtre pour fabriquer de
      la significativité).
- [x] Conventions de segment figées §5 (premier rendement incluant la
      jonction, drawdown par pic local, trades par `Fill.executedAt`)
      — sinon les folds seraient incomparables entre runs.

### Seuils §6
- [x] « baseline max » défini sans liberté post-hoc : max de Sharpe sur
      les **3 legacy figées** §4 — pas de sélection parmi des variantes
      additionnelles.
- [x] S4 porte sur la médiane des legacy et sur R30 : un edge concentré
      sur un trimestre ou déjà évaporé sur le mois récent ne passe pas.
- [x] INV-C6 : la grille n'active rien ; la proposition d'activation
      future reste l'unique décisionneuse.

## Risques résiduels assumés

- `fundingHistory` paginé par plages de ≤ 500 enregistrements : un trou
  horaire réel chez la venue invalide la collecte (fail-closed) — la
  campagne passe alors EN ATTENTE, elle ne compresse jamais la fenêtre.
- La bougie de prix Coinbase et le taux Hyperliquid viennent de venues
  différentes (miroir spot vs perp) : convention #27 assumée, inchangée
  ici ; un écart de prix miroir est un biais commun à tous les runs.
- 12 mois de données donnent des folds trimestriels courts (~90 points)
  : les Sharpe de segment sont bruités — S4 n'exige qu'un signe, pas une
  magnitude, précisément pour cette raison.
