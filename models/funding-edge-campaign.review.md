# Review — Protocole v2 de la campagne edge funding (DAO #35)

Statut : APPROUVÉ (amendement pré-enregistré, aucune correction bloquante)
Modèle : `models/funding-edge-campaign.md` (v2) +
`models/funding-edge-campaign-v2.annexe-calibration.json`
Date : 2026-09-04 — **avant toute collecte out-of-sample** (INV-C1 :
le SHA de ce commit précédera le premier fetch OOS dans l'historique)

Fichiers vérifiés : `models/funding-edge-campaign.md` v1 (git
`bd4a561`) et rapport v1 `docs/campaigns/funding-edge-campaign-2026-09.md`
(verdict non informatif : 0 trade, seuil 5e-5 jamais atteint),
`packages/strategies/src/funding-trend.ts` (double porte : longCarry
`fundingAvg ≤ −T` + EMA bullish → BUY ; shortCrowding `fundingAvg ≥ +T`
+ EMA bearish → SELL ; warm-up ⇒ HOLD),
`packages/indicators-prolog/src/engine.ts` + `prolog/indicators.pl`
(`funding_average` = sma sur le suffixe 72, `FUNDING_AVG_PERIOD = 72`),
`packages/backtest/src/replay.ts` (`fundingInputFor` suffixe aligné,
`applyFundingCost` avant point d'équité, pré-validation spot :
SELL sans position = INEXECUTABLE abandonné avant risk engine),
`packages/backtest/src/coinbase-history.ts` (couverture exacte exigée),
`packages/backtest/scripts/funding-edge-walkforward.ts` +
`collect-funding-history.ts` (v1, bornes #27/#30), fixtures
`dao30-*` + provenance SHA-256 revérifiées à la lecture,
`models/funding-rate-strategy.md` §5/§10, `models/backtest-run.md`.

## Checklist

### Séquence sacrée (C1 / INV-C1)
- [x] Le commit 1 contient : protocole v2, revue, **annexe de
      calibration in-sample** et 3 scripts — **aucun artefact OOS**.
      Les fixtures `dao35-*` ne peuvent exister qu'après (INV-C3 :
      jamais de fichier fabriqué), donc l'historique git prouve
      l'antériorité calibration → collecte.
- [x] La phase A ne lit que `dao30-*` (fenêtre close 2026-09-01) ; la
      fenêtre OOS démarre à cette même borne — aucune donnée OOS n'a
      pu entrer en calibration par construction temporelle.
- [x] `funding-edge-oos-v2.ts` re-vérifie le seuil contre l'annexe et
      échoue ferme en cas d'écart — le seuil ne peut pas dériver entre
      protocole et exécution.

### Calibration (phase A)
- [x] Règle mécanique sans liberté : quantile p90, **rang le plus
      proche sans interpolation**, sur 294 valeurs de `|fundingAvg|`
      (SMA-72 causale, miroir exact de `fundingInputFor`/`sma` Prolog).
      Reproductible bit à bit (le script écrit l'annexe).
- [x] Justification a priori du p90 consignée (fréquence ~30/an,
      sélectivité, candidates p90/p99 déjà nommées par le rapport v1
      **avant** toute donnée nouvelle) — le choix n'est pas guidé par
      un résultat de rejeu au seuil calibré.
- [x] Distribution complète annexée : 294 jours (fundingAvg signé,
      signal, raison, rendement, équité), quantiles |fundingAvg|,
      signaux (29 SELL / 265 HOLD / 0 BUY), métriques H12 + folds des
      4 runs + benchmark. Les métriques baseline coïncident avec le
      rapport v1 (rsi −0,078 / ema +0,241 / breakout −0,211 ;
      buy-and-hold −27,48 %) — contrôle de cohérence de la config §4.
- [x] Le constat in-sample « funding signé positif toute l'année ⇒ 0
      longCarry, 0 BUY, 0 trade » est annexé **tel quel** et n'a
      déclenché **aucune** retouche du seuil ou de la règle — c'est le
      test de la discipline INV-C7 en phase A.
- [x] Risque de sélection assumé et borné : l'auteur du protocole a vu
      les statistiques v1 (quantiles publiés) avant de fixer p90 ;
      c'est précisément ce que le brief #35 qualifie de calibration.
      Le point aveugle résiduel (choix du quantile non vérifiable sur
      données futures) est couvert par INV-C7 : une seule évaluation.

### Phase B et grille mécanique
- [x] A0 (≥ 90 bougies complètes couvertes) sépare « verdict » et « EN
      ATTENTE » sans zone grise ; l'état EN ATTENTE n'épuise pas
      l'itération unique (sinon une collecte 3 jours « consommerait »
      le verdict — contraire au brief).
- [x] Préfixe d'échauffement (90 bougies campagne-1) : état
      d'indicateurs uniquement, équité 10 000 au début du préfixe,
      métriques OOS par conventions de segment §5 v1 (jonction incluse,
      pic local, trades par `executedAt`) — aucun lookahead : le
      suffixe 72 à l'entrée OOS ne lit que le passé causal, miroir
      exact d'un passage live.
- [x] Grille A1–A4 reprise des seuils v1 S1/S2/S3/S5 à constantes
      identiques (0,25 / 30/an échelonné / +0,05 / ≥ 0) — aucune
      constante nouvelle à justifier ; A2 mise à l'échelle
      mécaniquement (`⌈30 × joursOOS / 365⌉`), pas à la main.
- [x] Abandon consigné de S4 (folds) : une fenêtre OOS unique ne se
      découpe pas ; tout test de stabilité = nouveau protocole. Écart
      documenté dans le protocole lui-même (§4.4), pas découvert a
      posteriori.
- [x] `fundingPaid` en phase B est indicatif (span complet préfixe+OOS,
      le cœur de rejeu ne l'impute pas par segment) : la grille ne
      l'utilise pas — aucun critère contaminé.
- [x] Benchmark buy-and-hold recalé sur la fenêtre OOS seule, formule
      de la suite inchangée.

### Lecture-seule (C2) et données réelles (C3)
- [x] Aucun fichier de production touché : scripts d'artefacts +
      modèles + fixtures uniquement ; `DEFAULT_REGIME_PERMISSIONS` et
      tout code de trading inchangés.
- [x] Collecte OOS = copie conforme des bornes #27/#30 v1 (1 MiB, 10 s,
      coercition, rejet entier, pagination capée, couverture
      bougie-par-bougie avant écriture) ; fixtures versionnées +
      provenance SHA-256, SHA revérifié à chaque lecture.

## Risques résiduels assumés

- Le régime de signe du funding (positif sur toute la campagne-1) peut
  persister hors-échantillon : la phase B conclura alors mécaniquement
  à un échec d'activité (A2) — verdict final, sujet clos (INV-C7).
  C'est un résultat informatif sur H2, pas un défaut du protocole.
- Fenêtre OOS initiale mécaniquement trop courte (collecte au
  2026-09-04 = 3 jours) : état EN ATTENTE attendu pour ce cycle ; la
  grille sera évaluée une fois sur la première fenêtre ≥ 90 jours.
- Les Sharpes de segment ~90 points restent bruités — A1/A4 n'exigent
  pas de magnitude élevée, et A2 borne la dépendance à l'activité.
