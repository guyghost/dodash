# Stratégie perp consciente du taux de financement (DAO #27)

Statut : MODÉLISÉ + IMPLÉMENTÉ (modèle §1-§8 ; branchement runtime §3
implémenté au cycle C1-suite sous son propre passage Model → Review →
Implement → Verify)

**Amendement dao #38** (§5, INV-F9) : le seuil d'entrée de
`funding-trend` est redéfini en **percentile figé** de la distribution
`|fundingAvg|` in-sample (campagne-1) — **VARIANT IN-SAMPLE, NON VALIDÉ
OUT-OF-SAMPLE**, inactif (permission en déni partout, C1). Revue 3 :
`models/funding-rate-strategy.review.md`.

## 1. Contexte et objet

Les instances `perp` exécutent des perpétuels Hyperliquid à partir des
bougies spot Coinbase du marché miroir (`models/hyperliquid-signals.md`).
Le coût de financement — paiement périodique entre longs et shorts,
publié par la venue — est aujourd'hui absent du dépôt (0 occurrence) :
ni lu, ni modélisé, ni pris en compte dans le backtest. Une stratégie
perp consciente du funding est invérifiable si le backtest ignore ce
coût : l'edge porté par le carry serait mesuré faux.

Objet de ce cycle, borné aux critères d'acceptation du brief :

1. un indicateur **pur** de funding moyen glissant
   (`packages/indicators-prolog`, pattern Prolog existant) ;
2. une stratégie **pure** `funding-trend` (`packages/strategies`),
   enregistrée, soumise à la permission de stratégie existante ;
3. l'intégration du **coût de funding** dans le PnL du backtest
   (`packages/backtest`) ;
4. le câblage de configuration (C4) et les tests contractuels.

Le branchement runtime de la couture (effet `fetchFundingData` +
interpréteur, §3) est modélisé puis implémenté au cycle C1-suite, sous
son propre passage Model → Review → Implement → Verify, avec les
corrections documentées en revue (alignement suffixe §4, double porte,
pas d'axe de retry nouveau). La machine n'est pas modifiée.

## 2. C1 — Décision de source de données funding

**Décision : le funding vient de l'API info Hyperliquid
(`POST /info { type: "fundingHistory", coin, startTime }`) et atteint le
cycle par une couture d'effets côté agent — pas par une nouvelle route
`mcp-market-data`.**

Chemin complet :

```
Hyperliquid /info (public, sans credential)
  → effet shell pur fetchHyperliquidFundingHistory
      (apps/agent/src/hyperliquid-execution.ts, pattern boundedRequest :
       réponse bornée 1 MiB, timeout 10 s, issues fermées, null si hors
       spec — jamais de zéros substitués ; corps { type: "fundingHistory",
       coin, startTime } avec startTime en ms ; chaque observation
       { time ≥ startTime, fundingRate } — fundingRate est sérialisé en
       CHAÎNE numérique par l'API : coercition via le helper finiteFrom
       existant (nombre ou chaîne numérique finie), tout autre forme
       rejette la lecture entière)
  → agrégation pure fundingRatesForCandles
      (série horaire → série 1:1 alignée sur les bougies de décision :
       moyenne des taux observés dans [start, start+tf) de chaque bougie ;
       bougie sans observation ⇒ série invalide, rejetée)
  → entrée optionnelle de computeIndicators (série {rates, avgPeriod})
  → snapshot : champ optionnel fundingAvg
  → stratégie funding-trend (pure)
```

Justification contre l'alternative (route `mcp-market-data` + cache KV) :

1. `apps/mcp-market-data` est modélisé comme la **frontière Coinbase
   read-only** (`models/effects.md` §MCP marché ;
   `models/hyperliquid-signals.md`). Le funding est une propriété de la
   **venue** Hyperliquid, pas du miroir spot : l'ajouter au worker
   introduirait un second couplage venue dans un worker mono-source, un
   nouveau schéma, une nouvelle variable d'environnement et un TTL KV à
   spécifier — surface qui n'existe dans aucun modèle actuel.
2. L'agent possède déjà le shell `/info` complet (réponses bornées,
   timeout, issues fermées, réglages figés) : le funding **sans
   credential** (endpoint public) réutilise ce shell à l'identique. La
   cohérence venue-exécution est préservée : la donnée de funding et
   l'exécution passent par la même frontière Hyperliquid.
3. Le chemin est **modélisable proprement** : requête déterministe (coin
   issu de `HYPERLIQUID_SIGNAL_MAP`, fenêtre dérivée de l'instant
   déclencheur), issues fermées, aucune credential, aucune nouvelle
   infrastructure, aucun état de machine nouveau. Aucune condition de
   STOP (C1) n'est rencontrée.
4. Le backtest consomme la **même série pure alignée** (1:1 par bougie)
   depuis ses fixtures/jeux de données : le cœur métier rejoué est
   strictement le même, sans I/O (`models/backtest-run.md`).

Sémantique fail-closed (héritée de `models/hyperliquid-shell.md`) : une
lecture indisponible ou hors spec ⇒ série absente ⇒ `fundingAvg` absent
du snapshot ⇒ la stratégie HOLD. Une décision n'est jamais prise avec un
input de funding partiel ou substitué.

## 3. Branchement runtime (implémenté, cycle C1-suite)

**Aucun changement de `tradingCycleMachine` ni de ses événements** : la
lecture funding est un fournisseur d'entrée de l'effet
`computingIndicators`, sur le modèle des lectures de compte qui
alimentent les gardes de risque. L'effet ne décide aucune transition :
les issues restent `INDICATORS_COMPUTED` / `INDICATORS_FAILED`
(`models/effects.md`).

Effet optionnel (couture, `apps/agent`) :

- `TradingCycleEffects.fetchFundingData?(configuration, candles) →
  readonly number[] | null` : jamais d'exception, jamais de zéro
  substitué ; `null` = indisponible (sémantique §2). Optionnel ⇒ les
  implémentations existantes de l'interface restent valides (C3).
- Fourni par `createTradingCycleEffects` **uniquement en mode perp avec
  réglages Hyperliquid résolus** (première porte) ; `coin` issu du
  mapping produit signal existant (`perpProductForSignal` +
  `hyperliquidCoin`).
- Fenêtre : suffixe des `FUNDING_AVG_PERIOD` dernières bougies de la
  série passée ; `startTime = start de la première bougie du suffixe` ;
  fetch `fundingHistory` puis agrégation 1:1 sur le suffixe
  (`fundingRatesForCandles`) → `rates` alignés par suffixe (§4).
- Deuxième porte côté interpréteur : la série n'est demandée que si
  mode perp ∧ `funding-trend` présent dans `strategyIds` ∧ effet
  câblé. Une instance perp qui n'exécute pas `funding-trend` ne
  provoque **aucun** fetch (zéro changement de comportement réseau,
  C3).
- Pré-validation interpréteur (INV-F2 à la frontière) : `1 ≤
  rates.length ≤ candles.length` et taux tous finis ; toute autre
  forme, comme toute indisponibilité, est traitée en `null` —
  **jamais un échec de cycle** pour un input optionnel. `computeIndicators`
  est alors appelé sans entrée funding ⇒ `fundingAvg` absent ⇒
  `funding-trend` HOLD. Aucun axe de retry nouveau (le retry
  `marketData` reste réservé aux bougies, input requis).
- Télémétrie : une indisponibilité attendue (portes passées, résultat
  `null`) émet `funding_data_unavailable` (structured warn), pour
  qu'un HOLD prolongé de la stratégie ne soit jamais silencieux.
- Les échantillons bruts ne sont pas checkpointés : l'artefact
  `indicators` porte le résultat (`fundingAvg` entre dans le hash du
  snapshot). Une reprise ré-exécute l'effet (lecture seule,
  idempotent) — un écart de `fundingAvg` entre tentatives ne peut
  jamais créer de décision avec un input partiel (champ absent ⇒
  HOLD).

## 4. Indicateur pur — funding moyen glissant

Définition (normative) : `fundingAvg` est la **moyenne arithmétique des
`avgPeriod` dernières observations de funding** alignées sur les bougies
de décision (taux par période, décimal : +0,0001 = les longs paient
0,01 % par période). Implémentation : prédicat Prolog
`funding_average(Rates, Period, Value)` dans `prolog/indicators.pl`
(enrobage de `sma/3` existant, gardes de positivité), requête par le
moteur uniquement quand une entrée funding est fournie.

Couture du moteur (`packages/indicators-prolog/src/engine.ts`) :

- `computeIndicators(candles, config, microstructure?, funding?)` —
  4e paramètre optionnel `{ rates: readonly number[]; avgPeriod: number }`.
- **Alignement par suffixe** (amendement C1-suite) : `rates` est aligné
  sur les **dernières** `rates.length` bougies de la série passée ;
  validation fail-closed : `1` implicite, `rates.length ≤
  candles.length`, taux tous finis, `avgPeriod` entier ≥ 2 ; toute
  autre forme ⇒ erreur (`INVALID_FUNDING_DATA`), jamais corrigée
  silencieusement. Motivation : une couverture 1:1 de la fenêtre
  runtime (350 bougies max) exigerait ~8 400 enregistrements
  `fundingHistory` (réponse proche du plafond 1 MiB) et rendrait
  l'entrée fragile — une heure manquée dans une vieille bougie
  invaliderait toute la série, alors que l'indicateur ne consomme que
  les `avgPeriod` derniers taux. Le backtest passe la série pleine
  (cas particulier du suffixe) ; la fenêtre du backtest qui précède
  `computeIndicators` par préfixe est tronquée en conséquence
  (`slice(max(0, n − avgPeriod), n)`).
- `rates.length >= avgPeriod` ⇒ requête Prolog et champ
  `fundingAvg?: number` dans le snapshot. `rates.length < avgPeriod` ⇒
  **champ absent** (sémantique d'échauffement, miroir du warm-up
  candles).
- **Aucun champ nouveau dans `IndicatorConfig`** : la période de
  l'indicateur voyage avec la donnée, pas avec la config candles. Les
  comparaisons de config (`validPreparedIndicators`, INV-E1/E2 de
  `models/ema-signal-decoupling.md`) restent inchangées ; le snapshot
  sans entrée funding est **bit-identique** à l'actuel.
- `FUNDING_AVG_PERIOD = 72` exporté de `@dodash/indicators-prolog` :
  source unique de la période figée, consommée par la couture runtime
  et le backtest.

Période figée : `avgPeriod = FUNDING_AVG_PERIOD = 72` observations (3
jours de funding horaire agrégé par jour en ONE_DAY — couvre les
cycles courts sans être du bruit d'intraday ; figé a priori, tout
balayage exclu).

## 5. Stratégie pure — `funding-trend`

`packages/strategies/src/funding-trend.ts`, pattern `rsi-reversion`/
`ema-cross` (config figée, `Object.freeze`, `strategySignal`,
`createSignal`). Config : `{ id?, enterThreshold?, baseSize }` — seuil
optionnel : absent ⇒ constante figée `FUNDING_TREND_ENTER_THRESHOLD`
(source unique `models/funding-rate-strategy.ts`) ; présent ⇒ valeur
du rejeu appelant (les rejeux campagne v1 #30/#35 passent leur seuil
explicitement : reproductibilité inchangée, INV-F9).

Règles de décision (seuils explicites figés, aucune décision LLM) —
combinaison du contexte de prix (paire EMA 12/26 existante du snapshot)
et de l'amplitude du funding moyen :

| Condition | Signal | reasonCode |
| --- | --- | --- |
| `fundingAvg` absent/non fini | HOLD | `FUNDING_WARMUP` |
| `emaFast > emaSlow` ∧ `fundingAvg ≤ −enterThreshold` | BUY | `FUNDING_LONG_CARRY` |
| `emaFast < emaSlow` ∧ `fundingAvg ≥ +enterThreshold` | SELL | `FUNDING_SHORT_CROWDING` |
| toute autre combinaison | HOLD | `FUNDING_NO_SIGNAL` |

Lecture : renforcer l'exposition quand la tendance haussière est portée
par un carry favorable (shorts paient les longs, `fundingAvg` négatif) ;
la réduire quand la tendance est baissière avec un financement chargé
contre les longs. Le prix donne le sens, le funding donne l'autorisation
d'amplitude — jamais l'un sans l'autre.

- Confidence : `min(1, (|fundingAvg| − enterThreshold) / enterThreshold)`
  — nulle au seuil, croissante avec l'amplitude, saturée à 2× le seuil.
  `suggestedSize = baseSize` (convention registre).
- `emaFast === emaSlow` ⇒ HOLD (contexte de prix non tranché).
- Aucune lecture de `previousIndicators` : le signal est un état, pas une
  transition (pas de double émission à éviter ; l'allocation et la
  permission amortissent de toute façon les répétitions).

Seuils figés (un seul degré de liberté, aucun balayage) :

| Paramètre | Valeur | Justification |
| --- | --- | --- |
| `enterThreshold` | **`FUNDING_TREND_ENTER_THRESHOLD = 8,8750099537037e-6` par période** (amendement dao #38 ; valeur v1 : `5e-5`, choix a priori #27 jamais atteint — 0 jour traversé in-sample, 0 trade sur H12, stratégie inopérante, cf. `docs/analysis/analyse-backtest-2026-09-04.md` §3) | percentile p75 de `|fundingAvg|` — règle de dérivation figée ci-dessous, écrite AVANT le rejeu comparatif (C3) |
| `baseSize` | `0.01` | convention des 3 stratégies du registre (inchangée) |
| `avgPeriod` | `72` | §4 (inchangée) |

Règle de calibration figée (amendement dao #38 — fixée au commit du
présent modèle, avant tout rejeu au nouveau seuil) :

- **Quantité calibrée** : `|fundingAvg|` — SMA 72 jours causale
  (`FUNDING_AVG_PERIOD`, §4), c'est-à-dire la grandeur effectivement
  consommée et seuillée par la stratégie. Le percentile porte sur cette
  quantité (jours de décision), pas sur les taux horaires bruts : c'est
  la fraction de jours d'autorisation qui est contrôlée.
- **Dataset** : fixtures campagne-1 `packages/backtest/fixtures/dao30-*`
  (fenêtre close `[2025-09-01, 2026-09-01)`, empreintes SHA-256 des
  fichiers de provenance) — les mêmes données que l'annexe de
  calibration #35 ;
  **aucune donnée nouvelle** n'est collectée pour cet amendement.
- **Règle** : quantile **p75**, méthode du rang le plus proche
  (`h = ⌈p/100 × N⌉`, valeur au rang `h` de la série triée, sans
  interpolation) sur les **294 jours de décision** (365 − 71
  d'échauffement) → valeur figée `8,8750099537037e-6`, identique à
  `distributionAbsFundingAvg.p75` de
  `models/funding-edge-campaign-v2.annexe-calibration.json` (artefact
  commité #35) : la valeur est dérivée d'un artefact antérieur, la
  dérivation est reproductible bit à bit.
- **Justification chiffrée du p75** : bande cible 5–25 % d'échantillons
  au-dessus du seuil. p75 traverse **74/294** jours de décision
  in-sample (**25,2 %**) contre **0/294** au seuil v1 `5e-5` ; p90
  (`1,0106e-5`, 30/294 = 10,2 %) est écarté : c'est le seuil calibré du
  protocole #35 (EN ATTENTE), dont l'itération unique (INV-C7 v2)
  interdit d'ailleurs le recalibrage et dont la valeur ne doit pas
  devenir un défaut produit — p75 sépare le défaut produit du seuil de
  campagne et rend le rejeu comparatif moins dégénéré (74 vs 30
  traversées in-sample).

**Étiquetage explicite (dao #38) : VARIANT IN-SAMPLE — NON VALIDÉ
OUT-OF-SAMPLE (INV-F9).** La validation hors-échantillon reste l'objet
du protocole #35 en cours (EN ATTENTE), qui porte ses propres seuils
figés (calibrés p90) — aucune retouche de ce protocole. Toute
activation runtime/paper reste déniée par défaut
(`DEFAULT_REGIME_PERMISSIONS` inchangé : `funding-trend` déniée dans
les 3 régimes — C1) et ne peut venir que d'une proposition séparée,
évaluée sur une validation out-of-sample.

Constat pré-enregistré (dérivé de l'annexe #35 AVANT le rejeu, aucune
observation nouvelle) : `fundingAvg` signé est resté **strictement
positif** sur toute la campagne-1 (min `+2,17e-7`, max `+1,18e-5`) —
la branche longCarry (`fundingAvg ≤ −T`) ne peut jamais s'autoriser
cette fenêtre, et la branche shortCrowding ne remplit pas (rejeu
long-only, vente à découvert inexécutable). Le rejeu comparatif H12
est donc attendu à **0 remplissage quel que soit le seuil positif** :
le recalibrage rétablit l'autorisation d'amplitude (74 jours traversés
au lieu de 0), il ne peut pas créer de trade sur cette fenêtre — c'est
une propriété de structure du régime de signe, consignée #35 (§3 v2),
pas un effet de la hauteur du seuil.

## 6. Backtest — coût de funding dans le PnL

`BacktestConfig` gagne `fundingRates?: readonly number[]` (série 1:1
alignée sur les bougies de décision : `rates[i]` = taux couvrant la
bougie `i`).

- Application à chaque bougie, à la clôture, position ouverte :

  `coût = positionQuantity × close × rates[i]`

  (long paie un taux positif, reçoit un taux négatif ; portefeuille
  backtest long-only). Le coût est déduit du `cash` AVANT le point
  d'équité de la bougie ⇒ PnL, equity curve, drawdown, sharpe le
  reflètent par construction.
- `BacktestResult` gagne `fundingPaid: number` (somme des coûts, exposé
  pour testabilité ; les métriques existantes ne changent pas de forme).
- `fundingRates` absent ⇒ **aucune écriture de cash, replay
  bit-identique** à l'actuel (INV-F7). `fundingRates` présent de
  longueur ≠ bougies ou non fini ⇒ `INVALID_BACKTEST_CONFIG`.
- Le reste du replay (permission, allocation, risque, fills, protective)
  est inchangé — le funding est un coût de détention, pas une décision.
- **Double usage de la série** (amendement C1-suite) : `fundingRates`
  porte le COÛT (cidessus) et alimente l'INDICATEUR dans le chemin non
  préparé : chaque `computeIndicators(history, …)` reçoit le suffixe
  `{ rates: slice(max(0, n − avgPeriod), n), avgPeriod:
  FUNDING_AVG_PERIOD }` où `n = history.length` (alignement suffixe,
  §4). Les snapshots préparés (`prepareBacktestIndicators`, resté
  funding-blind) font autorité sur les VALEURS d'indicateur : un replay
  préparé qui veut `funding-trend` actif doit fournir des snapshots
  portant déjà `fundingAvg` (fixtures) — la série ne nourrit alors que
  le coût. `prepareBacktestIndicators` avec entrée funding est une
  extension possible, hors périmètre.

## 7. C4 — Effets de l'ajout à `STRATEGY_IDS` (listés avant implémentation)

Id ajouté : `"funding-trend"` (4e entrée de l'enum, `max(3)` inchangé).

| Surface | Effet |
| --- | --- |
| `apps/agent/src/configuration.ts` | enum Zod `strategyIds` élargi ; `max(3)` inchangé (au plus 3 stratégies par instance) ; `requiredCandles` inchangé (l'input de la stratégie n'est pas une bougie) |
| `apps/agent/src/strategy-registry.ts` | case `funding-trend` avec seuils figés §5 (`enterThreshold: FUNDING_TREND_ENTER_THRESHOLD`, constante `models/funding-rate-strategy.ts`) ; traité comme rsi-reversion côté sizing : **non calibré** (`CALIBRATED_STRATEGY_IDS` inchangé, source `models/confidence-calibration.ts`) |
| `models/regime-filter.ts` `DEFAULT_REGIME_PERMISSIONS` | **inchangé** : l'id est absent des 3 listes ⇒ dénié partout ⇒ stratégie inactive tant qu'une table `regimePermissions` explicite ne l'autorise pas (C3) |
| `models/live-trading-policy.ts` | **inchangé** : `LIVE_TRADING_POLICY.strategyIds` (3 ids) ⇒ toute config live spot contenant `funding-trend` est rejetée `LIVE_POLICY_MISMATCH` (C2/C3) |
| `models/hyperliquid-execution.ts` admission perp | **inchangée** : `admitHyperliquidPerpConfiguration` ne vérifie pas `strategyIds` ; l'activation reste un choix opérateur via config perp + permission de régime |
| `packages/backtest` | `fundingRates` optionnel (§6) ; `DEFAULT_REGIME_PERMISSIONS` s'applique ⇒ inactive par défaut dans tout replay existant (C3) |

## 8. Invariants

| # | Invariant |
| --- | --- |
| INV-F1 | Aucune entrée funding (moteur, replay) ⇒ snapshots, requêtes Prolog, PnL et equity **bit-identiques** à l'actuel ; les 3 stratégies et le mode paper spot ne changent pas de comportement (C2/C3). |
| INV-F2 | Fail-closed : série de funding invalide (longueur ≠ bougies, taux non fini, période < 2) ⇒ erreur fermée ; lecture runtime indisponible ⇒ série absente ⇒ `fundingAvg` absent ⇒ HOLD. Jamais de zéro substitué, jamais de signal avec input partiel. |
| INV-F3 | Échauffement : `rates.length < avgPeriod` ⇒ `fundingAvg` absent ⇒ HOLD (`FUNDING_WARMUP`). |
| INV-F4 | La stratégie est pure et déterministe : seuils figés en config, aucune décision LLM, aucune lecture d'horloge ni d'effet ; la décision combine toujours prix ET amplitude. |
| INV-F5 | La permission de stratégie existante (`resolveRegimePermission` + `DEFAULT_REGIME_PERMISSIONS`) s'applique sans aménagement : `funding-trend` est dénié dans tous les régimes tant que non permis explicitement. |
| INV-F6 | La calibration de confiance reste réservée à `CALIBRATED_STRATEGY_IDS` ; `funding-trend` n'y entre pas. |
| INV-F7 | Le coût de funding n'affecte que le cash à la clôture des bougies couvertes : `fundingPaid = Σ position × close × rate` ; absent ⇒ bit-exact (INV-F1). |
| INV-F8 | Le chemin runtime C1 est une couture d'effets : le shell Hyperliquid traduit le monde en séries typées fermées ; `tradingCycleMachine` décide ; aucun LLM nulle part. |
| INV-F9 | Le seuil percentile (dao #38) est un **VARIANT IN-SAMPLE, non validé out-of-sample** : dérivé une seule fois par la règle figée §5 (aucun balayage, aucun recalibrage post-rejeu) ; `funding-trend` reste **déniée en runtime/paper** (`DEFAULT_REGIME_PERMISSIONS` et `LIVE_TRADING_POLICY` inchangés) tant qu'aucune proposition séparée ne l'active sur la foi d'une validation OOS ; les rejeux campagne v1 (#30 : `5e-5` explicite ; #35 : p90 calibré explicite) restent reproductibles bit à bit (C1/C2/C3). |

## 9. Livrables et vérification

- `models/funding-rate-strategy.md` + `.review.md` (commit 1, `feat(models)`).
- `packages/indicators-prolog` : `funding_average` (+ `prepare:prolog`),
  entrée `funding?`, champ `fundingAvg?`, `FUNDING_AVG_PERIOD` ; tests
  déterministes (valeur exacte sur fixture, warm-up, rejets
  fail-closed, alignement suffixe, INV-F1 bit-exact).
- `packages/strategies` : `funding-trend` + export ; tests fixtures
  (BUY/SELL/HOLD, seuils, warm-up, config invalide).
- `packages/backtest` : `fundingRates` + `fundingPaid` ; tests : replay
  sans funding bit-identique, replay avec funding dont `pnl` diffère
  exactement de `fundingPaid`, stratégie inactive sans permission
  (`deniedByStrategy`), coût nul sans position, chemin non préparé
  alimenté par la série (stratégie réellement active avec permission).
- `apps/agent` : enum + registre ; `fetchHyperliquidFundingHistory` et
  `fundingRatesForCandles` purs/testés (fetch mocké, hors spec ⇒ null,
  agrégation 1:1, bougie sans observation ⇒ rejet) ; admission live
  spot/perp inchangées (tests de non-régression).
- Branchement runtime (cycle C1-suite) : effet optionnel
  `fetchFundingData` (fourni perp seulement, réglages résolus),
  interpréteur `computingIndicators` avec double porte et
  pré-validation ; tests : série disponible ⇒ snapshot avec
  `fundingAvg` et signal émis, paper spot ⇒ jamais d'appel (C2), effet
  absent ou `null` ⇒ cycle continue sans funding (C3).
- Amendement dao #38 : constante figée `models/funding-rate-strategy.ts`
  (+ test de verrouillage de la valeur), seuil optionnel dans la
  stratégie pure (défaut = constante), registre agent sur la constante,
  rejeu comparatif v1/v2 (`packages/backtest/scripts/
  funding-threshold-comparison.ts`) sur les fixtures dao30/dao35 —
  mode comparaison descriptif : trades/PnL/Sharpe v1 (0 trade) vs v2,
  distribution des signaux, constat de structure de signe ; le script
  re-vérifie la constante contre l'annexe #35 (tout écart est fatal).
- Vérifications : `pnpm check`, tests des paquets touchés, `pnpm build`,
  `pnpm lint` sans nouveau warning.

## 10. Hors périmètre

- Branchement du fetch dans l'interpréteur du cycle (§3) — cycle séparé,
  machines concernées (`trading-cycle`).
- Short perp, levier, sizing par amplitude : le backtest reste
  long-only, `baseSize` fixe (l'exposition se module par la permission
  et la confiance, comme les 3 stratégies existantes).
- Campagne de mesure de l'edge (walk-forward funding) : les données de
  funding historiques ne sont pas dans le dépôt ; toute campagne sera
  pré-enregistrée avec ses propres portes, sur données réelles
  `fundingHistory`.
- Balayage des seuils/périodes (§4-§5 : figés, une variante = nouvelle
  hypothèse pré-enregistrée). La dérivation percentile §5 est une règle
  figée évaluée une fois sur des données déjà commitées — ce n'est pas
  un balayage (miroir #35 §9).
