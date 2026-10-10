# Modèle — Politique d'exposition cible P7 (tendance × volatilité), paper uniquement

Statut : normatif (2026-10-10). Source : `docs/analysis/allocation-policies-2026-10-09.md`
(politique P7, protocole `models/allocation-policies-campaign.md`, commit
`d620d5e`). Amende `agent-runtime.md` (étape d'allocation) et
`multi-product-portfolio.md` (créneaux par produit).

## 1. Objet

Remplacer, **en paper uniquement**, la décision « signal BUY/SELL × notional
fixe » par une **exposition cible en % de l'équité du créneau produit** :

```
cible(d) = tendance(d) ? min(1, volCible / vol30(d)) : 0
```

- `tendance(d)` : clôture de la bougie `d` > moyenne simple des 200 dernières
  clôtures (incluant `d`).
- `vol30(d)` : écart-type échantillon des 30 derniers rendements simples
  journaliers (jusqu'à `d`), annualisé √365.
- `volCible = 0,50`.

Chaque produit (BTC-USD, ETH-USD) est un **créneau indépendant** (capital,
cash et position propres, `multi-product-portfolio.md`). C'est la
transposition par créneau de P7, dont les deux poches de 50 % sont
indépendantes à la règle de dérive près (§3).

Le LLM n'intervient pas ; la décision est une fonction pure et déterministe des
bougies closes et de l'état du créneau.

## 2. Cible figée (sans état persistant)

Pour la bougie de décision `t` (dernière bougie close) :

1. **Ancre** `a` = la bougie la plus récente `d ≤ t` telle que `d` débute un
   **lundi** UTC, **ou** `tendance(d) ≠ tendance(d − 1)`, où `d − 1` est la
   bougie précédente **contiguë** (24 h plus tôt).
2. **Cible figée** = `cible(a)`.

La cible est ainsi recalculée chaque semaine et à chaque changement de
tendance du produit, puis tenue fixe entre deux ancres. Elle se
déduit des seules bougies : aucune donnée persistée, aucune migration d'état.
Fenêtre minimale : `200 + 7 + 1` clôtures pour trouver l'ancre et sa tendance
précédente, `31` pour `vol30` ; la configuration exige **`candleLimit ≥ 240`**.
Si l'historique fourni est insuffisant, **discontinu** (deux bougies
consécutives à plus ou moins de 24 h) ou si `vol30` est nulle, la décision est
`HOLD` avec raison `INSUFFICIENT_HISTORY` (jamais d'ordre sur indicateur
partiel). Le runtime ne fournit déjà que des séries contiguës (contrôle
d'intégrité INV-I7) ; la garde est défensive.

**Écarts assumés vs P7** (simulateur du rapport) : P7 recalcule les deux
cibles quand la tendance de **l'un** des actifs change, rééquilibre les deux
poches quand **l'une** dérive, et ramène les poches à 50/50 ; ici chaque
créneau est indépendant (règles par produit, pas de transfert de cash entre
créneaux). Ces écarts sont mesurés par le test de cohérence (§7).

## 3. Rééquilibrage partiel

Équité du créneau `E = cash + q × prix`, exposition `f = q × prix / E`,
`prix` = clôture de `t` (prix d'exécution paper du runtime).

Un ordre est émis si **l'une** des conditions suivantes est vraie :

- `t` est l'ancre (lundi ou changement de tendance) ;
- `t` débute le **1er jour du mois** UTC ;
- `|f − cibleFigée| > dérive`, avec **`dérive = 0,10`** du créneau (transposé
  des 5 points de P7 exprimés sur un portefeuille à deux poches égales ;
  l'équivalence cesse dès que les équités des créneaux divergent).

Montant : `Δ = cibleFigée × E − q × prix` ($).

- `Δ > 0` (achat) : plafonné à `cash / ((1 + slippage)(1 + frais))`, marge
  relative 1e-9 — c'est le coût réel de l'exécution paper (prix × (1 + s),
  frais sur ce notionnel) ; jamais de cash négatif, sans levier.
- `Δ < 0` (vente) : notionnel `min(|Δ|, q × prix)` (jamais de vente à
  découvert).
- Le minimum `minOrderNotional` (**10 $**) est vérifié **après** les plafonds
  ci-dessus : ordre ignoré si le notionnel plafonné est inférieur.
- Quantité = notionnel plafonné / prix (vente : bornée à `q`).

Sortie : `{ side: BUY | SELL | HOLD, quantity, reason, target, exposure,
trend, vol30, anchorStart }`, où `reason ∈ { ANCHOR, MONTH_START, DRIFT,
IN_BAND, BELOW_MIN_ORDER, INSUFFICIENT_HISTORY }`.

## 4. Intégration runtime

- `sizingPolicy` gagne la variante **`TARGET_EXPOSURE`** `{ volTarget: 0.5,
  trendSmaPeriod: 200, volPeriod: 30, driftThreshold: 0.1, minOrderNotional:
  10 }` (constantes figées, validées à l'égalité).
- Étape `allocating` de l'interpréteur : si la politique est
  `TARGET_EXPOSURE`, l'ordre provient de la décision §3 et non de
  `allocateSignals`. Raison : l'allocateur plafonne aussi les **ventes** par
  le cash disponible, ce qui empêcherait toute réduction d'exposition d'un
  créneau entièrement investi. L'identifiant d'ordre suit le même schéma
  (`createClientOrderId(agentId, cycleId, decisionId, 0)`).
- Stratégie **`target-exposure`** : seule stratégie admise avec cette
  politique (et réservée à elle). Signal informatif : `BUY` si tendance,
  `SELL` sinon, confiance = cible, `suggestedSize = 0`. Elle documente les
  entrées de la décision ; elle ne dimensionne rien.
- **Gardes de risque** (amendement de revue du 2026-10-10) :
  - **achat** : `checkRisk` complet puis admission portefeuille. La perte
    journalière transmise à `checkRisk` est `min(dailyPnl, pnlBougie)`, où
    `pnlBougie = q × (clôture_t − clôture_{t−1})` est la variation du créneau
    sur la bougie de décision (amendement de revue PR #24 : en paper, la
    fenêtre journalière n'est valorisée sur la nouvelle bougie qu'à la fin du
    cycle, donc `dailyPnl` vaut 0 à la seule décision du jour ; `pnlBougie`
    est exact car la position ne change qu'aux clôtures) ;
  - **vente (réduction d'exposition)** : `checkRisk` avec une perte
    journalière neutralisée (le garde perte journalière ne bloque **jamais**
    une réduction) ; pas d'admission portefeuille (une réduction ne peut pas
    augmenter l'exposition consolidée). Le kill switch, la vente à découvert
    et les plafonds restent appliqués.
  - `maxDecisionNotional` ne s'applique pas (pas d'allocateur) ;
    `cooldownMs = 0` **exigé** par la validation (un cooldown pourrait
    bloquer une réduction, INV-T7).
- **Ordres manqués** : la garde « une décision par bougie » s'applique ; un
  achat d'ancre ou de début de mois refusé (perte journalière, échec de
  cycle) n'est pas rejoué sur la même bougie ; il est rattrapé à la bougie
  suivante par la règle de dérive (> 10 points), sinon à l'ancre suivante.

## 5. Garde-fous

1. **Paper uniquement** : `TARGET_EXPOSURE` est refusée par la validation de
   configuration si `executionMode ≠ "paper"`. `LIVE_TRADING_ENABLED` et
   `HYPERLIQUID_PERP_TRADING_ENABLED` restent `false`.
2. Sans levier, long-only : exposition ∈ [0 ; 1] du créneau, jamais de cash
   négatif, jamais de vente au-delà de la position.
3. **Coupe-circuit** : perte journalière par créneau (`risk.maxDailyLoss`,
   2 500 $), mesurée sur la bougie de décision (§4). Sous cette politique il
   **bloque les achats** de la bougie, jamais une réduction (§4). Le
   coupe-circuit **consolidé** (`portfolioRisk.maxDailyLoss`) lit des pertes
   publiées à la fin du cycle précédent, donc en retard d'une bougie : il est
   **neutralisé** (validation ≥ 1e9). C'est un **affaiblissement accepté pour
   le paper** : il ne reste que les coupe-circuits par créneau (2 500 $
   chacun), qui ne bloquent pas un achat sur un créneau dont la perte est
   sous son seuil même si la perte totale dépasse 5 000 $ (ex. BTC −2 400 $,
   ETH −2 700 $). Un coupe-circuit consolidé à jour exigerait de publier la
   perte de bougie à l'orchestrateur avant l'admission (hors périmètre). Montants absolus : quand l'équité croît, le coupe-circuit
   devient plus conservateur (il bloque les achats sur une perte relative plus
   faible), jamais plus permissif. Le kill switch opérateur reste prioritaire.
4. Les SL/TP (`stopLossBps`/`takeProfitBps`) ne déclenchent rien en paper
   (seuls les brackets live les utilisent) ; ils n'interfèrent pas.
5. **Plafonds absolus neutralisés** : `maxOrderNotional`,
   `maxPositionNotional`, `maxGrossExposure` (créneau) et
   `portfolioRisk.maxGrossExposure` rejettent un ordre entier, y compris une
   vente, et ne suivent pas la croissance de l'équité. La validation exige
   pour cette politique des valeurs **≥ 1 000 000 000 $** (ainsi que pour
   `portfolioRisk.maxDailyLoss`, cf. 3.) : l'exposition est bornée
   structurellement par INV-T2 (≤ équité du créneau, sans levier).

## 6. Configuration paper

`docs/operations/paper-p7-start.json` : corps `/start` du portefeuille
BTC-USD + ETH-USD, `ONE_DAY`, intervalle 3 600 s, `candleLimit 240`,
`strategyIds ["target-exposure"]`, `sizingPolicy TARGET_EXPOSURE`, capital
10 000 $ par créneau, plafonds absolus à 1e12 $, `maxDailyLoss` 2 500 $
par créneau, consolidé neutralisé (1e12), `cooldownMs 0`. La bascule depuis la
campagne daily (stop, reset, start) est une opération documentée dans le
runbook, **non exécutée** par ce changement.

## 7. Cohérence avec le rapport P7 (tolérance figée)

Test `packages/backtest/test/target-exposure-coherence.test.ts` : rejoue la
décision §3 jour par jour (fenêtre glissante de 240 bougies, comme le
runtime), la **porte de risque §4** (`checkRisk` avec la configuration paper
P7, `dailyPnl` du runtime = 0 à la décision et `pnlBougie` calculé comme dans
l'interpréteur) et l'exécution paper du runtime (`executePaperOrder`, 60 + 2 bps),
deux créneaux de 10 000 $ (créneau ETH en cash avant 2016-05-19), sur les
bougies archivées de la campagne daily long (SHA-256 vérifiés). Tolérance
figée avant exécution :

- drawdown maximal du portefeuille ≤ **50 %** sur tout l'historique et dans
  chacune des 5 fenêtres du protocole ;
- `|CAGR − 52,0 %| ≤ 8 points` ;
- `|drawdown max − 45,6 %| ≤ 6 points`.

Les écarts attendus (créneaux indépendants au lieu d'un portefeuille
rééquilibré en commun ; poche ETH en cash au lieu de BTC avant 2016-05-19)
sont la raison de la tolérance. **Un échec du test interdit le déploiement** ;
il ne justifie jamais un élargissement de la tolérance (nouveau modèle).

## 8. Invariants

- **INV-T1** : décision pure, déterministe, fonction des seules bougies closes
  et de `(cash, q)` du créneau.
- **INV-T2** : `0 ≤ exposition après ordre ≤ 1` du créneau ; aucun cash négatif.
- **INV-T3** : aucune vente au-delà de la position.
- **INV-T4** : aucun ordre sur historique insuffisant.
- **INV-T5** : politique refusée hors paper.
- **INV-T6** : les autres politiques de sizing et la stratégie `target-exposure`
  sont mutuellement exclusives.
- **INV-T7** : une réduction d'exposition n'est jamais bloquée, sauf par le
  kill switch (ni perte journalière, ni plafond absolu, ni admission
  portefeuille).

## 9. Vérification requise

- Unitaires (horloge et bougies injectées) : SMA200 et vol30 ; ancre lundi ;
  ancre au changement de tendance ; cible figée entre deux ancres ; achat
  plafonné au cash ; vente plafonnée à la position ; seuil de dérive ; 1er du
  mois ; micro-ordre ignoré ; historique insuffisant.
- Configuration : refus hors paper, refus `candleLimit < 240`, refus d'un
  plafond absolu < 1e9 (créneau et consolidé), exclusivité
  stratégie/politique.
- Interpréteur : une vente est bloquée par le kill switch (seule exception à
  INV-T7).
- Interpréteur : un créneau entièrement investi peut vendre (cash 0) ; une
  vente passe malgré une perte journalière dépassée ; un achat est bloqué par
  elle, y compris quand `dailyPnl = 0` mais que la bougie de décision a perdu
  plus que `maxDailyLoss`.
- Cohérence §7.
