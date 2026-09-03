# Stratégie perp consciente du taux de financement (DAO #27)

Statut : MODÉLISÉ (en attente de review ; implémentation soumise aux
critères d'acceptation du brief DAO #27)

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

Le chemin runtime complet (branchement du fetch de funding dans
`tradingCycleMachine`) est modélisé ici (§3) mais **hors périmètre
d'implémentation** : il touche l'orchestration du cycle et exigera son
propre passage Model → Review → Implement → Verify avec machines.
La couture pure (fetch + agrégation, testés) est livrée pour que le
chemin C1 existe concrètement et soit réutilisable tel quel.

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

## 3. Modèle runtime (couture, hors périmètre d'implémentation ce cycle)

Dans une instance perp, le cycle (`computingIndicators`) obtiendrait la
série par l'effet ci-dessus AVANT `computeIndicators` et passerait
l'entrée optionnelle ; `tradingCycleMachine` reste l'orchestrateur,
l'effet ne décide aucune transition (`models/effects.md`). La fenêtre de
fetch : `startTime = dernière clôture évaluée − avgPeriod × tf`, `coin`
issu du mapping produit signal → coin Hyperliquid existant. Ce
branchement est consigné ici comme spécification ; sa mise en œuvre
(modification de l'interpréteur du cycle) fera l'objet d'un cycle
séparé. Tant qu'il n'est pas branché, la stratégie est inactive au sens
plein : aucune source runtime ne produit `fundingAvg`.

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
- Validation fail-closed : `rates.length === candles.length`, tous les
  taux finis, `avgPeriod` entier ≥ 2 ; toute autre forme ⇒ erreur
  (`INVALID_FUNDING_DATA` / `INVALID_CONFIG`), jamais corrigée
  silencieusement.
- `rates.length >= avgPeriod` ⇒ requête Prolog et champ
  `fundingAvg?: number` dans le snapshot. `rates.length < avgPeriod` ⇒
  **champ absent** (sémantique d'échauffement, miroir du warm-up
  candles).
- **Aucun champ nouveau dans `IndicatorConfig`** : la période de
  l'indicateur voyage avec la donnée, pas avec la config candles. Les
  comparaisons de config (`validPreparedIndicators`, INV-E1/E2 de
  `models/ema-signal-decoupling.md`) restent inchangées ; le snapshot
  sans entrée funding est **bit-identique** à l'actuel.

Période figée : `avgPeriod = 72` observations (3 jours de funding
horaire agrégé par jour en ONE_DAY — couvre les cycles courts sans être
du bruit d'intraday ; figé a priori, tout balayage exclu).

## 5. Stratégie pure — `funding-trend`

`packages/strategies/src/funding-trend.ts`, pattern `rsi-reversion`/
`ema-cross` (config figée, `Object.freeze`, `strategySignal`,
`createSignal`). Config : `{ id?, enterThreshold, baseSize }`.

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

Seuil figés a priori (un seul degré de liberté, aucun balayage) :

| Paramètre | Valeur | Justification a priori |
| --- | --- | --- |
| `enterThreshold` | `5e-5` par période | ≈ 4× la base Hyperliquid (0,01 %/8 h ⇒ 1,25e-5/h agrégé) : n'agit que sur un financement anormalement chargé, bruité en dessous |
| `baseSize` | `0.01` | convention des 3 stratégies du registre |
| `avgPeriod` | `72` | §4 |

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

## 7. C4 — Effets de l'ajout à `STRATEGY_IDS` (listés avant implémentation)

Id ajouté : `"funding-trend"` (4e entrée de l'enum, `max(3)` inchangé).

| Surface | Effet |
| --- | --- |
| `apps/agent/src/configuration.ts` | enum Zod `strategyIds` élargi ; `max(3)` inchangé (au plus 3 stratégies par instance) ; `requiredCandles` inchangé (l'input de la stratégie n'est pas une bougie) |
| `apps/agent/src/strategy-registry.ts` | case `funding-trend` avec seuils figés §5 ; traité comme rsi-reversion côté sizing : **non calibré** (`CALIBRATED_STRATEGY_IDS` inchangé, source `models/confidence-calibration.ts`) |
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

## 9. Livrables et vérification

- `models/funding-rate-strategy.md` + `.review.md` (commit 1, `feat(models)`).
- `packages/indicators-prolog` : `funding_average` (+ `prepare:prolog`),
  entrée `funding?`, champ `fundingAvg?` ; tests déterministes (valeur
  exacte sur fixture, warm-up, rejets fail-closed, INV-F1 bit-exact).
- `packages/strategies` : `funding-trend` + export ; tests fixtures
  (BUY/SELL/HOLD, seuils, warm-up, config invalide).
- `packages/backtest` : `fundingRates` + `fundingPaid` ; tests : replay
  sans funding bit-identique, replay avec funding dont `pnl` diffère
  exactement de `fundingPaid`, stratégie inactive sans permission
  (`deniedByStrategy`), coût nul sans position.
- `apps/agent` : enum + registre ; `fetchHyperliquidFundingHistory` et
  `fundingRatesForCandles` purs/testés (fetch mocké, hors spec ⇒ null,
  agrégation 1:1, bougie sans observation ⇒ rejet) ; admission live
  spot/perp inchangées (tests de non-régression).
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
  hypothèse pré-enregistrée).
