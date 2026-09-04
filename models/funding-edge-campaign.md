# Campagne d'edge funding en lecture-seule (DAO #30)

Statut : PROTOCOLE FIGÉ (pré-enregistré avant toute observation de données
réelles — voir INV-C1 et l'historique git)

## 1. Contexte et objet

La stratégie `funding-trend` (models/funding-rate-strategy.md §5) est
mergée et câblée runtime (#27) mais reste **inactive au sens plein** :
`DEFAULT_REGIME_PERMISSIONS` la dénie dans tous les régimes et aucune
table explicite ne l'autorise. La donnée qu'elle consomme — l'historique
de financement Hyperliquid — n'existe dans le dépôt sous aucune forme
versionnée : aucun edge n'a jamais été mesuré. Les seuils
(`enterThreshold = 5e-5`, période 72) ont été choisis **a priori, sans
mesure** ; models/funding-rate-strategy.md §10 place explicitement
toute campagne d'edge derrière un protocole pré-enregistré sur données
réelles.

Objet de cette campagne : **mesurer, rien d'autre**.

- comparaison `funding-trend` contre la baseline prix-seul (les 3
  stratégies legacy de la suite : `rsi-reversion`, `ema-cross`,
  `breakout`) sur des fenêtres figées, en backtest, coût de funding
  intégré ;
- production d'un rapport versionné dont toute future proposition
  d'activation pourra s'autoriser — sans que ce rapport n'active quoi
  que ce soit.

Périmètre **strictement lecture-seule** (INV-C2) : aucun changement de
permission, aucun code de trading touché, aucun branchement nouveau. La
décision d'activation est l'objet d'une proposition séparée évaluée
contre le rapport.

## 2. Fenêtres d'observation figées

Toutes les bornes sont des instants UTC alignés sur minuit (multiples de
86 400 000 ms). Fenêtre primaire :

| Fenêtre | Borne incluse | Borne exclue | Durée |
| --- | --- | --- | --- |
| **H12** (historique) | 2025-09-01T00:00:00Z | 2026-09-01T00:00:00Z | 365 jours |
| **R30** (récent) | 2026-08-02T00:00:00Z | 2026-09-01T00:00:00Z | 30 jours |
| **F1** | 2025-09-01T00:00:00Z | 2025-12-01T00:00:00Z | 91 jours |
| **F2** | 2025-12-01T00:00:00Z | 2026-03-01T00:00:00Z | 90 jours |
| **F3** | 2026-03-01T00:00:00Z | 2026-06-01T00:00:00Z | 92 jours |
| **F4** | 2026-06-01T00:00:00Z | 2026-09-01T00:00:00Z | 92 jours |

- R30 est le dernier mois de H12 ; F1–F4 sont ses 4 trimestres
  consécutifs. Ces sous-fenêtres servent uniquement à la **stabilité**
  (§6) : elles découpent la courbe d'équité d'un rejeu causal unique,
  elles ne re-calibrent rien.
- Le rejeu est **causal par construction** (indicateurs calculés
  uniquement sur le préfixe passé à chaque bougie, exécution sur la
  bougie suivante — models/backtest-run.md) : le découpage en folds
  n'introduit aucun lookahead.
- Échauffement assumé : `fundingAvg` n'est défini qu'à partir de la
  72e bougie (FUNDING_AVG_PERIOD, models/funding-rate-strategy.md §4)
  et les indicateurs requis couvrent ~28 bougies ; les ~72 premiers
  jours de H12 ne produisent pas de décision. La fenêtre effective de
  décision est donc d'environ 293 jours — chiffre constaté, pas
  ajustable.

## 3. Sources de données et provenance

Deux sources, réutilisées à l'identique de la couture #27 (aucune
nouvelle route, aucun credential) :

| Donnée | Source | Convention |
| --- | --- | --- |
| Taux de financement | `POST https://api.hyperliquid.xyz/info` `{ type: "fundingHistory", coin: "BTC", startTime, endTime }` — endpoint public, sans signature | Pagination ≤ 500 enregistrements par appel ; paramètres bornés #27 (réponse ≤ 1 MiB, timeout 10 s, coercition chaîne→nombre, toute lecture hors spec rejette la collecte entière — jamais de zéro substitué) |
| Bougies de prix | Coinbase spot `BTC-USD`, timeframe `ONE_DAY` (miroir spot, models/hyperliquid-signals.md) | Chargement via `loadCoinbaseHistoricalDataset` (données complètes exigées : tout trou rejette la collecte) |

Provenance (INV-C4, héritée de models/backtest-run.md : « un résultat
sans provenance n'est pas un backtest valide ») : chaque fixture est
persistée **versionnée** sous `packages/backtest/fixtures/` avec un
fichier de provenance distinct : endpoint, coin/produit, fenêtre
`[startTime, endTime)`, horodatage de collecte, nombre
d'enregistrements, nombre d'appels réseau, paramètres bornés employés,
et **SHA-256 du fichier de données**.

Alignement coût : la série de coût journalière est la moyenne des taux
horaires observés dans `[start, start + 24 h)` de chaque bougie
(convention `fundingRatesForCandles` #27). Une bougie sans observation
rend la collecte invalide — la campagne ne démarre pas sur une série
partielle.

## 4. Rejeu comparatif — configuration figée

Un seul cœur de rejeu (`packages/backtest`, chemin non préparé : les
snapshots préparés sont funding-blind et ne peuvent pas alimenter
`funding-trend` — models/funding-rate-strategy.review.md, limite
consignée). La même configuration exacte est employée pour les 4
stratégies et le benchmark :

| Paramètre | Valeur |
| --- | --- |
| Produit / timeframe | `BTC-USD`, `ONE_DAY` |
| Capital initial | 10 000 |
| `maxDecisionNotional` / `minNetQuantity` | 2 000 / 1e-6 |
| Sizing | `TARGET_SIGNAL_NOTIONAL` = 1 000 (models/backtest-run.md, appliqué à chaque stratégie) |
| Indicateurs | `DEFAULT_INDICATOR_CONFIG` (EMA 12/26 communs à toutes) |
| Risque | V1 campagne : ordre 2 000, position 10 000, brut 20 000, perte journalière 1 000, cooldown 0, SL 150 bps, TP 300 bps |
| Broker papier | frais 6 bps, slippage 2 bps |
| Sortie protectrice / filtre de régime | `NONE` / absent — aucun gating : comparabilité prix-seul pure |
| Calibration | `IDENTITY` pour toutes (aucune calibration : comparabilité) |
| `fundingRates` | série journalière H12 (§3), **identique pour les 4 runs** |

Runs figés :

| Run | Stratégie | Seuils |
| --- | --- | --- |
| `funding-trend` | `createFundingTrendStrategy` | `enterThreshold = 5e-5` (figé #27) |
| `rsi-reversion` | baseline legacy | 30 / 70 |
| `ema-cross` | baseline legacy | défaut registre suite |
| `breakout` | baseline legacy | lookback 20 |
| benchmark | buy-and-hold | convention suite |

- La baseline est **prix-seul** au sens strict : ses signaux ne lisent
  jamais le funding. Le coût de funding est néanmoins appliqué à tous
  les runs (INV-C5) — une détention perp paie le financement quelle que
  soit la stratégie ; comparer une baseline sans coût à un run avec
  coût biaiserait en faveur de la baseline.
- La baseline « meilleure » de référence est celle des 3 legacy qui
  maximise le Sharpe H12 net de funding (§5) — max **observé après
  coup sur les 3 fixés ici**, jamais parmi d'autres variantes.

## 5. Métriques

Par run, sur H12 (métriques du cœur backtest, inchangées) :

| Métrique | Définition |
| --- | --- |
| **Sharpe net de funding** | `metrics.sharpe` : rendements journaliers de la courbe d'équité, annualisation √252 — nette par construction (le coût est déduit du cash avant le point d'équité, #27 §6) |
| **Drawdown maximal** | `metrics.maxDrawdown` : perte relative au pic courant de l'équité |
| **Nombre de trades** | nombre de fills exécutés (`trades.length`, convention commune aux runs) |
| **Coût de funding** | `fundingPaid` : somme signée des coûts appliqués (INV-F7) |
| PnL / retour total / turnover | `metrics.pnl`, `metrics.totalReturn`, `metrics.turnover` |

Par sous-fenêtre (R30, F1–F4), recalcul sur la sous-courbe d'équité du
même rejeu — conventions figées :

- rendements journaliers du segment, le premier incluant la variation
  depuis le dernier point du segment précédent ;
- drawdown relatif au pic courant **dans le segment** ;
- trades dont `fill.executedAt` ∈ `[début, fin)` du segment ;
- Sharpe segment annualisé √252 (rendements journaliers).

## 6. Seuils de décision recommandés

**Ce sont des entrées pour la future proposition d'activation, pas des
activations** (INV-C6). Notations : S = Sharpe H12 net de funding,
DD = drawdown H12, N = nombre de trades H12 ; « baseline max » = max de
S sur les 3 legacy figées (§4).

| # | Seuil recommandé | Justification a priori |
| --- | --- | --- |
| S1 | S(funding-trend) ≥ S(baseline max) + **0,25** | un différentiel inférieur au bruit d'échantillon annuel n'autorise aucune décision |
| S2 | N(funding-trend) ≥ **30** | significativité minimale ; la stratégie est à seuil élevé, sa fréquence est en soi une donnée d'activation |
| S3 | DD(funding-trend) ≤ DD(baseline max) + **0,05** | l'edge ne se paie pas en risque de perte de plus de 5 points |
| S4 | différentiel S(funding-trend) − médiane S(legacy) ≥ 0 sur **au moins 3 des 4 trimestres** ∧ ≥ 0 sur R30 | l'edge ne doit pas se concentrer sur un seul trimestre ni s'évanouir sur le mois récent |
| S5 | S(funding-trend) ≥ **0** | la stratégie reste non destructive après coûts de financement |

**Grille de lecture recommandée** : activation considérable seulement si
S1 ∧ S2 ∧ S3 ∧ S4 ∧ S5 ; sinon rejet, ou nouvelle hypothèse = nouveau
protocole pré-enregistré. Cette grille n'engage que la lisibilité du
rapport : la décision d'activation reste une proposition séparée
(INV-C6).

## 7. Rapport et écarts

Le rapport versionné (`docs/campaigns/`) consigne : le manifeste
complet (fenêtres, sources, SHA-256, config §4), les tableaux de
métriques §5 par run et par sous-fenêtre, l'évaluation des seuils §6,
et **tout écart au protocole, consigné comme tel** (donnée
indisponible, fenêtre tronquée, échec de collecte réseau…). Un écart
n'est jamais corrigé a posteriori par une retouche de protocole : il
est rapporté, ou la campagne est marquée **EN ATTENTE de données**
(INV-C3 — protocole et scripts prêts, aucune donnée inventée).

## 8. Invariants

| # | Invariant |
| --- | --- |
| INV-C1 | **Aucune retouche des seuils, fenêtres, métriques ou conventions après la première observation de données réelles.** Toute modification = nouveau protocole, pré-enregistré par un commit daté avant la nouvelle observation. L'historique git fait foi : ce protocole est commité avant le premier fetch. |
| INV-C2 | Lecture-seule : la campagne ne modifie aucune permission, aucun code de trading, aucun branchement ; `funding-trend` reste déniée en runtime pendant toute la campagne. |
| INV-C3 | Données réelles ou rien : aucune donnée synthétique ou inférée dans le rapport de campagne ; les fixtures de test unitaires restent séparées des fixtures de campagne. Échec de collecte ⇒ état EN ATTENTE avec protocole et scripts prêts. |
| INV-C4 | Provenance : toute donnée du rapport porte endpoint, fenêtre, horodatage de collecte et SHA-256 ; un résultat sans provenance n'est pas un backtest valide. |
| INV-C5 | Comparabilité : même bougies, même config, même série de coût de funding pour tous les runs comparés ; toute asymétrie est un écart à consigner. |
| INV-C6 | La campagne ne décide rien : les seuils §6 sont des entrées recommandées ; seule une proposition séparée peut activer. |

## 9. Livrables et vérification

- Commit 1 (celui-ci) : `models/funding-edge-campaign.md` + `.review.md`
  — **avant tout fetch** (INV-C1).
- Script de collecte : `packages/backtest/scripts/collect-funding-history.ts`
  (bornes #27, pagination, fixtures + provenance SHA-256) ;
  fixtures sous `packages/backtest/fixtures/` (INV-C3 : absent si
  collecte impossible — jamais de fichier de données fabriqué).
- Script de rejeu : `packages/backtest/scripts/funding-edge-walkforward.ts`
  (config §4, métriques §5, stabilité §6).
- Rapport : `docs/campaigns/funding-edge-campaign-2026-09.md`.
- Vérifications : `pnpm check`, tests des paquets touchés, `pnpm build`,
  `pnpm lint` sans nouveau warning. Aucun changement de code de
  production : les scripts et fixtures sont des artefacts de campagne.

## 10. Hors périmètre

- Toute activation : permission de régime, table `regimePermissions`,
  live policy, admission perp — inchangés (INV-C2).
- Balayage des seuils ou de la période (5e-5 / 72 figés #27) : une
  variante = nouvelle hypothèse, nouveau protocole.
- Short perp, levier, sizing par amplitude : le rejeu reste long-only,
  sizing `TARGET_SIGNAL_NOTIONAL` uniforme.
- ETH ou tout autre coin : la campagne porte le coin de la
  configuration perp de référence (BTC) ; une extension = nouveau
  protocole.
