# Portefeuille multi-produits avec budget de risque consolidé (DAO #24)

Statut : MODÉLISÉ (revue incluse ; le branchement runtime est modélisé au §9
mais **hors périmètre d'implémentation** de ce cycle — voir §3).

## 1. Contexte et objet

DoDash opère aujourd'hui des agents mono-produits : `AgentConfiguration` porte
un seul `productId` (`apps/agent/src/configuration.ts`), `tradingCycleMachine`
orchestre un cycle à produit unique (`models/trading-cycle.machine.ts`,
`models/agent-runtime.md`), et `packages/risk` plafonne les garde-fous
(`maxOrderNotional`, `maxPositionNotional`, `maxGrossExposure`,
`maxDailyLoss`, cooldown, stop/take-profit) **par agent**. Aucun plafond
d'exposition consolidée n'existe : N agents mono-produits respectent chacun
leur limite locale tout en pouvant porter collectivement une exposition N fois
la limite sur des marchés corrélés.

Objet de ce cycle, borné aux critères d'acceptation du brief :

1. un modèle normatif + machine XState du **portefeuille multi-produits**
   (ce document et `models/multi-product-portfolio.machine.ts`) ;
2. une configuration Zod acceptant `products[]` (1..N) **strictement
   rétrocompatible** pour le mono-produit ;
3. un cœur pur d'évaluation des garde-fous **consolidés et par produit**
   dans `packages/risk` ;
4. un **backtest multi-produits** rejetant le même cœur métier sans I/O
   (`packages/backtest`).

## 2. Problème visé

Un plafond local (`maxGrossExposure = 20 000` par agent) appliqué à N agents
n'empêche pas une exposition totale de N × 20 000. Le risque doit être plafonné
à **deux étages** :

1. **par produit** : les garde-fous existants d'un `RiskConfig` s'appliquent
   tels quels à chaque produit (aucune sémantique changée) ;
2. **consolidé** : `maxGrossExposure` et `maxDailyLoss` au niveau du
   portefeuille bornent la somme des expositions et des pertes quotidiennes
   de **tous** les produits d'un même agent.

## 3. C1 — Décision de périmètre (honnêteté)

**Décision : ce cycle livre le cœur pur (configuration multi-produits,
garde-fous consolidés, backtest multi-produits — tous testés) plus le modèle
complet du branchement runtime (§5 et §9), et PAS le branchement runtime
lui-même.**

Le branchement complet (un Durable Object pilotant N instances de
`tradingCycleMachine`, une par produit, avec artifacts, persistance SQLite,
scheduling et résumé d'état par produit) touche l'orchestration entière de
`apps/agent` : `interpreter.ts` (sac d'artifacts mono-ordre), `state.ts`
(résumé mono-produit), `trading-agent.ts` (clé d'instance `(produit ×
stratégies)`), `trading-effects.ts` (exécution par produit), le worker et les
routes de contrôle. Un seul passage ne peut pas livrer cette refonte
**proprement et sûr** : livrer un branchement partiel non testé est interdit
par le brief. Le pattern est celui du #27 : la couture pure est livrée,
réutilisable telle quelle, et le chemin runtime est spécifié ici pour son
propre passage Model → Review → Implement → Verify.

Le cœur pur livré couvre exactement les critères 2, 3, 4 et 5 du brief ; le
critère 1 (modèle + revue) est intégralement couvert par ce document, la revue
et la machine du §5.

## 4. Invariants normatifs

- **INV-P1 (plafond consolidé)** : la somme des expositions brutes projetées
  des produits (`Σ_p notional position projeté de p`, chaque position
 	projectée remplaçant la position courante du produit) reste ≤
  `portfolioRisk.maxGrossExposure`. Un ordre qui n'augmente pas l'exposition
  (`Δ ≤ 0`, ex. une vente qui réduit une position) est toujours évalué même
  si le plafond est déjà dépassé : dérisquer n'est jamais bloqué.
- **INV-P2 (perte quotidienne consolidée)** : si `Σ_p dailyPnl_p ≤
  −portfolioRisk.maxDailyLoss`, aucun produit n'obtient d'admission
  (`CONSOLIDATED_DAILY_LOSS_LIMIT`) : le coupe-circuit portefeuille arrête
  tout nouveau risque, pas seulement le produit perdant.
- **INV-P3 (quiescence par produit)** : un produit arrêté (`stopped`),
  suspendu (`halted`) ou en échec (`failed`) n'émet plus aucune proposition
  et ne bloque jamais l'admission des autres produits. Seuls INV-P1 et INV-P2
  bloquent plusieurs produits à la fois, par définition consolidée.
- **INV-P4 (ordre déterministe)** : les produits sont traités par identifiant
  trié (ordre des points de code). Les sommes consolidées itèrent les clés
  triées. L'admission est une fonction pure de l'historique d'événements :
  rejouer les mêmes événements produit les mêmes décisions. Quand deux ordres
  tiennent chacun seul mais pas ensemble, le premier en ordre trié gagne.
- **INV-P5 (le modèle décide)** : toute admission consolidée est une garde de
  la machine du §5 ou une fonction pure du §6. Les effets et AI workers
  produisent des signaux ; ils ne décident jamais d'une transition ni d'une
  admission.
- **INV-P6 (rétrocompatibilité stricte)** : `parseAgentConfiguration` sans
  `products[]`, ou avec `products[]` d'un élément, produit **exactement** la
  configuration d'aujourd'hui : même forme (aucune clé ajoutée), mêmes
  valeurs résolues, mêmes admissions live/perp, même sortie sérialisée.
- **INV-P7 (admissions, C4)** : en multi-produits (N ≥ 2), seul
  `executionMode: "paper"` est admissible ce cycle ; live et perp sont
  rejetés fail-closed (`MULTI_PRODUCT_LIVE_UNSUPPORTED`). Le branchement du
  §9 étendra les admissions **existantes** (`assessLiveTradingPolicy`,
  `admitHyperliquidPerpConfiguration`, `LIVE_TRADING_POLICY`,
  `HYPERLIQUID_PERP_POLICY`) par produit — jamais en les contournant.
- **INV-P8 (backtest = même cœur)** : le replay multi-produits réutilise les
  mêmes étapes purs que `replayBacktest` (indicateurs → stratégies →
  allocation → risque par produit + consolidé → courtier paper) sans I/O ni
  horloge globale. Les couches optionnelles du replay mono-produit
  (sorties protectrices, filtre de régime) ne sont pas admises en
  multi-produits ce cycle : absentes de la configuration, donc impossibles à
  silencieusement ignorer.

## 5. Machine XState — portefeuille multi-produits

Source normative : `models/multi-product-portfolio.machine.ts`
(`multiProductPortfolioMachine`). La machine modélise l'orchestrateur du DO :
un acteur par produit (une `tradingCycleMachine` future), des rapports
d'exposition, et l'admission consolidée des propositions de risque.

### 5.1 Contexte

- `products` : identifiants triés, uniques, non vides (normalisés à l'entrée ;
  doublon, liste vide ou limites non positives ⇒ état `rejected`, fail-closed).
- `statuses` : `running | stopped | halted | failed` par produit.
- `exposure` : exposition brute engagée par produit (notional), dernier état
  commité.
- `dailyPnl` : dernier PnL quotidien rapporté par produit.
- `limits` : `PortfolioRiskLimits { maxGrossExposure, maxDailyLoss }`.
- `killSwitchActive`, `lastDecision`, `lastError`.

### 5.2 Événements

| Événement | Producteur (effet) | Effet attendu |
| --- | --- | --- |
| `PORTFOLIO_STARTED` | shell opérateur | démarrer les N cycles produits |
| `PRODUCT_STOPPED/HALTED/FAILED` | cycle produit terminé | mise à jour de `statuses` (INV-P3) |
| `PRODUCT_EXPOSURE_REPORTED` | lecture de compte/positions | rafraîchir `exposure` et `dailyPnl` du produit |
| `RISK_PROPOSED` | interpréteur du cycle produit en phase `checkingRisk` | admission consolidée (INV-P1, INV-P2) ; décision lisible dans `lastDecision` |
| `KILL_SWITCH_ENGAGED` | contrôle opérateur | passage en `draining` : plus aucune admission, les cycles en cours terminent proprement |
| `RESET` | contrôle opérateur | retour à `idle` depuis `complete`/`halted` |

### 5.3 Transitions

- `validating → idle | rejected` (entrée invalide, terminal).
- `idle → running` sur `PORTFOLIO_STARTED` (tous les produits `running`).
- `running` :
  - `RISK_PROPOSED` : garde `admissible` = produit connu et `running`
    (INV-P3), kill switch inactif, `Σ dailyPnl > −maxDailyLoss` (INV-P2) et
    `Σ exposure (proposition remplaçant l'exposition du produit) ≤
    maxGrossExposure` (INV-P1) — sinon rejet motivé dans `lastDecision`.
  - `PRODUCT_STOPPED/HALTED/FAILED` : mise à jour d'un seul produit.
  - `always → complete` quand tous les produits sont quiescents (INV-P3).
  - `KILL_SWITCH_ENGAGED` (identifiant de contrôle présent) → `draining`.
- `draining` : tout `RISK_PROPOSED` est rejeté
  (`CONSOLIDATED_KILL_SWITCH`) ; `always → halted` quand tous les produits
  sont quiescents.
- `complete`/`halted` : `RESET → idle`.

La machine ne calcule ni indicateur, ni signal, ni sizing ; elle ne connaît
ni prix ni ordre — uniquement des notionals d'exposition rapportés par les
effets (INV-P5). La projection phase → effet du produit reste celle de
`models/agent-runtime.md`, instanciée par produit.

## 6. Cœur pur — évaluation consolidée (`packages/risk`)

Source : `evaluatePortfolioRisk(products, limits)` dans
`packages/risk/src/portfolio.ts` (fonction pure, sans I/O ni horloge — C3).

Entrée : par produit, `intent` (`OrderIntent` ou `null`), `snapshot`
(`RiskSnapshot` existant) et `config` (`RiskConfig` existant, budget du
produit) ; plus `limits` (`PortfolioRiskLimits` consolidé). Sortie :
décision par produit, triée par identifiant (INV-P4) :

1. identifiants dupliqués ou limites non positives ⇒ erreur (fail-closed) ;
2. `Σ dailyPnl ≤ −maxDailyLoss` ⇒ tous rejetés
   (`CONSOLIDATED_DAILY_LOSS_LIMIT`, INV-P2) ;
3. sinon, en ordre trié : `checkRisk` existant par produit (sémantique
   inchangée, y compris kill switch et cooldown) ; un rejet local n'affecte
   pas les autres (INV-P3) ; un ordre approuvé localement est admis si et
   seulement si le total consolidé courant, avec sa contribution projetée,
   reste ≤ `maxGrossExposure` (INV-P1), sinon
   `CONSOLIDATED_GROSS_EXPOSURE_LIMIT` ; les produits sans `intent`
   (`NO_ORDER`) contribuent leur position courante au socle.

La convention numérique est celle de `checkRisk` : rejet strictement au-delà
du plafond (`> plafond`), jamais à l'égalité.

## 7. Configuration Zod `products[]`

Source : `apps/agent/src/configuration.ts`. `inputSchema` gagne deux champs
optionnels : `products` (1..`MAX_AGENT_PRODUCTS` = 8 créneaux
`{ productId, risk? }`, mêmes schémas et défauts que `riskSchema`) et
`portfolioRisk` (`{ maxGrossExposure, maxDailyLoss }` positifs).

Règles normatives (INV-P6, INV-P7) :

- `products` et `productId` sont mutuellement exclusifs
  (`INVALID_CONFIGURATION`).
- **N = 1** : normalisation vers la forme legacy — la configuration produite
  est celle de `parseAgentConfiguration({ productId, ...shared, risk })`,
  par construction (même pipeline, aucune clé `products`/`portfolioRisk` en
  sortie). Comportement strictement identique, admissions incluses. Un
  `portfolioRisk` fourni avec N = 1 est ignoré : à un seul produit, le
  budget par produit est le seul garde-fou, les plafonds consolidés sont
  absents de la configuration multi normalisée.
- **N ≥ 2** : `portfolioRisk` requis, `risk` top-level interdit
  (`INVALID_CONFIGURATION`) — le budget vit par produit, le plafond vit au
  portefeuille ; créneaux triés par identifiant et figés ;
  `executionMode` ≠ `paper` ⇒ `MULTI_PRODUCT_LIVE_UNSUPPORTED` (INV-P7).
- La porte runtime (`trading-agent.ts`) refuse fail-closed toute
  configuration multi-produits (`MULTI_PRODUCT_UNSUPPORTED`) tant que le
  branchement du §9 n'existe pas : une configuration validée ne doit jamais
  être pilotée par l'interpréteur mono-produit actuel.
- `parseMultiProductAgentConfiguration(input)` est l'entrée pure qui produit
  la `MultiProductAgentConfiguration` validée et figée (1..N), consommée par
  le backtest du §8 et, plus tard, par le branchement.

## 8. Backtest multi-produits (même cœur, sans I/O)

Source : `replayMultiProductBacktest` dans
`packages/backtest/src/multi-product-replay.ts` (C3 : pure, sans I/O).

- Entrée : `runId`, `agentId`, capital partagé, `maxDecisionNotional`
  (total par décision), `minNetQuantity`, `broker`, `portfolioRisk`, et par
  produit : `productId`, `candles`, `strategies`, `indicators`, `risk`.
  Séries de même longueur et horodatages alignés sinon erreur
  (`MISALIGNED_PRODUCT_CANDLES`) ; identifiants uniques, créneaux triés.
- À chaque pas `t` : exécution des ordres en attente à l'ouverture
  `t` (même sémantique que le replay mono-produit via `executePaperOrder`,
  trésorerie partagée, positions par produit) ; puis pour `t` ≥ warmup
  maximal : indicateurs, stratégies et signaux **par produit** ; signaux
  mis en commun dans `allocateSignals` (déjà multi-produits : groupes par
  produit, clés triées, budget notional partagé — INV-P4) ; snapshots de
  risque par produit (position produit, fenêtre quotidienne produit via
  `resolveDailyRiskWindow` sur le PnL realized + latent du produit,
  pré-validation spot par produit) ; admission consolidée par
  `evaluatePortfolioRisk` (INV-P1, INV-P2) ; ordres approuvés mis en attente
  pour l'ouverture suivante.
- Courbe d'équité : trésorerie + Σ positions valorisées au close.
  Métriques : `calculateMetrics` sur la courbe et les trades consolidés.
- Sorties protectrices et filtre de régime : hors périmètre multi-produits
  (INV-P8) — absents de la configuration, donc non simulables par accident.

## 9. Couture runtime (modèle du branchement — futur passage)

Spécification normative du branchement, **non implémenté ce cycle** :

1. **Instance** : la clé d'instance du DO devient le portefeuille
   `(stratégies × créneaux produits)` ; la configuration persistée est la
   `MultiProductAgentConfiguration` figée du §7, modifiable uniquement à
   l'état `stopped`.
2. **Orchestration** : le DO instancie un acteur `tradingCycleMachine` par
   produit (input = configuration produit projetée : `productId`, `risk` du
   créneau, champs partagés). Chaque produit suit la projection
   `models/agent-runtime.md` à l'identique ; les effets reçoivent le
   `productId` en paramètre (données de marché, indicateurs, stratégies,
   allocation, persistance, exécution). Aucune nouvelle phase machine n'est
   créée.
3. **Admission consolidée** : en phase `checkingRisk`, après `checkRisk`
   local approuvé, l'interpréteur du produit émet `RISK_PROPOSED` vers
   l'orchestrateur du §5 (acteur durable du DO) avec l'exposition projetée
   du produit et ne poursuit (`RISK_APPROVED`) que sur décision `approved`.
   Le refus consolide en `RISK_REJECTED` produit. La machine décide ; les
   effets exécutent (INV-P5).
4. **Rapports** : après chaque cycle produit (et au réveil), l'effet de
   lecture de compte publie `PRODUCT_EXPOSURE_REPORTED` (exposition et PnL
   quotidien par produit) ; la somme consolidée pilote INV-P2.
5. **Quiescence** : `PRODUCT_STOPPED/HALTED/FAILED` d'un produit ne
   re-planifie jamais les autres (INV-P3). L'arrêt global passe par
   `KILL_SWITCH_ENGAGED` (déjà modélisé).
6. **Admissions live/perp (C4)** : chaque créneau est admis individuellement
   par les admissions existantes (enveloppe figée par produit, miroir perp
   par produit) ; une seule admission refusée ⇒ démarrage refusé. Tant que
   ce câblage d'admission par produit n'existe pas, la porte runtime refuse
   le multi-produits hors paper (INV-P7).
7. **Persistance** : tables existantes étendues du `productId` sur les
   lignes cycles/intentions/ordres ; le résumé d'état synchronisé expose un
   état par produit. Restauration : tout champ ajouté est normalisé
   fail-closed (règle `models/agent-runtime.md`).

## 10. Restant explicite

Non livré ce cycle (futur passage Model → Review → Implement → Verify) :

- le branchement runtime du §9 (orchestrateur DO, interpréteur par produit,
  portes fail-closed levées, worker et routes) ;
- les admissions multi-produits live/perp par créneau (C4) ;
- les couches optionnelles du replay (sorties protectrices, régime) en
  multi-produits ;
- l'allocation inter-produits avancée (poids par créneau) — l'allocateur
  existant, déjà multi-produits et déterministe, est conservé tel quel.

## 11. Amendement 2026-09-04 (dao #43) — politique d'instance paper production

Constat opérationnel (déploiement paper #42, instance `btc-usd-paper`) : une
instance démarrée par `/start` **mono-produit** rejette systématiquement chaque
décision en `RISK_REJECTED` (errorCode `null`). Cause exacte : la couture
d'admission consolidée (§9.3, INV-P5) est câblée sans condition dans les effets
de cycle (`createEffects`), alors que l'état mono-produit ne crée jamais
`portfolioSession` (voix legacy §9.1/N=1) — chaque `RISK_PROPOSED` reçoit donc
`UNKNOWN_PRODUCT` (refus fermé). Le cœur de risque n'est pas en cause :
`checkRisk` local approuve (l'allocateur plafonne déjà le notional à
`maxDecisionNotional`) ; c'est la couture qui n'a pas de machine portefeuille
à interroger.

**Décision (config d'instance, cœur de risque inchangé)** : les instances
paper de production (24/7, préfixe isolé) sont configurées en **mode
portefeuille N ≥ 2 créneaux** (§9), seul chemin où la couture d'admission est
branchée sur un orchestrateur `running`. Le chemin mono-produit (voix legacy
N=1) reste réservé aux essais locaux et tests tant qu'une proposition dédiée
ne corrige pas le câblage conditionnel de la couture, selon
Model → Review → Implement → Verify.

Instance de référence (runbook
`docs/operations/paper-deployment-runbook.md`) : créneaux BTC-USD + ETH-USD,
`initialCapital` 10 000 par créneau, `maxDecisionNotional` 2 000,
`portfolioRisk` consolidé { `maxGrossExposure` 20 000, `maxDailyLoss` 1 000 },
`executionMode` paper (INV-P7).
