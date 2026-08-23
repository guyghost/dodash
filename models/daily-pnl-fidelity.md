# Fidélité dailyPnl du replay — alignement sur `resolveDailyRiskWindow`

Statut : VÉRIFIÉ (D3'' PASS — équivalence bit-identique, cf. §8)

## 1. Contexte et décision

Décision sortante n°2 du diagnostic `risk-rejection-diagnosis.md` §7 : le
replay backtest diverge structurellement du live sur la mesure `dailyPnl`
consommée par le risk engine (`DAILY_LOSS_LIMIT`).

- **Replay** (`packages/backtest/src/replay.ts` L706) :
  `dailyPnl: equityBefore − config.initialCapital` — PnL **cumulé depuis
  le début du run**, jamais ré-ouvert.
- **Live** (`apps/agent/src/trading-agent.ts` L339-371) : fenêtre UTC
  persistée (`state.dailyRiskWindow`), résolue via
  `models/daily-risk.ts → resolveDailyRiskWindow(current, now, markedEquity)`,
  ré-ouverte à chaque changement de jour UTC ; `dailyPnl = markedEquity −
  openingEquity` de la fenêtre courante.
- **Prédicat** (`packages/risk/src/risk.ts` L85-87) :
  `snapshot.dailyPnl <= -config.maxDailyLoss → REJECTED/DAILY_LOSS_LIMIT`.

Deux asymétries résultantes :
1. Replay trop **sévère** : drawdown cumulé < −maxDailyLoss → rejets
   DAILY_LOSS_LIMIT fantômes sur des jours réellement gagnants.
2. Replay trop **laxiste** : forte perte journalière masquée par un cumul
   positif → ordres acceptés que le live aurait rejetés.

La campagne D2 (V1, journalier) n'a déclenché aucun DAILY_LOSS_LIMIT —
l'asymétrie n'a pas encore mordu, mais la mesure est fausse en soi.

## 2. Mécanique relevée (inchangée)

`resolveDailyRiskWindow` (source de vérité, inchangée) :

```
utcDayStart = floor(now / DAY_MS) * DAY_MS
si current === null ou current.utcDayStart ≠ utcDayStart :
    window = { utcDayStart, openingEquity: markedEquity }   // reset jour
sinon : window = current
dailyPnl = markedEquity − window.openingEquity
```

Le live roule la fenêtre à **chaque cycle**, ordres ou pas, et persiste
`window` dans l'état de l'agent.

## 3. Modèle — intégration au replay

Aucun nouveau résolveur : le replay **consomme** `resolveDailyRiskWindow`
déjà exporté par `@dodash/models`. État ajouté au run :

- `dailyRiskWindow: DailyRiskWindow | null` — initialisé `null` en tête de
  run, muté candle par candle, invisible hors de la boucle.

Transition par candle (avant la boucle d'ordres) :

```
equityCandle = portfolio.cash + portfolio.positionQuantity × candle.close
assessment   = resolveDailyRiskWindow(dailyRiskWindow, candle.start, equityCandle)
dailyRiskWindow ← assessment.window
snapshot.dailyPnl = assessment.dailyPnl       (pour tous les checkRisk du candle)
```

Machine de la fenêtre (implicite au résolveur, exposée pour review) :

| État                | Événement                    | Transition                          |
|---------------------|------------------------------|-------------------------------------|
| AUCUNE (null)       | candle                       | OUVERTE(jour du candle, equity)     |
| OUVERTE(j)          | candle, jour = j             | OUVERTE(j) (inchangée)              |
| OUVERTE(j)          | candle, jour ≠ j             | OUVERTE(nouveau jour, equity)       |

### Invariants

- **INV-P1** : la fenêtre est roulée à **chaque** candle (ordres ou pas) —
  miroir du live qui roule à chaque cycle. Ne pas conditionner au seul
  chemin « ordre à évaluer », sous peine de marquer l'openingEquity au
  premier jour avec ordre (dérive).
- **INV-P2** : `snapshot.dailyPnl` provient exclusivement de
  `assessment.dailyPnl` ; aucune autre source dans le replay.
- **INV-P3** (conséquence, ONE_DAY aligné UTC) : chaque candle est un
  nouveau jour UTC → fenêtre ré-ouverte à chaque candle → `dailyPnl = 0`
  à chaque évaluation → `DAILY_LOSS_LIMIT` structurellement inopérant en
  journalier. C'est le **miroir exact** du live journalier (première
  résolution du jour → fenêtre neuve → dailyPnl = 0). La limite ne peut
  mordre que sur des timeframes infra-journaliers (plusieurs évaluations
  par jour UTC), où la fenêtre persiste intra-jour.
- **INV-P4** : équivalence économique attendue **bit-identique** sur V1 :
  DAILY_LOSS_LIMIT = 0 partout pré-changement (campagne D2), et le
  nouveau chemin ne peut créer un rejet que si `0 ≤ −maxDailyLoss` (faux
  pour maxDailyLoss > 0).
- **INV-P5** : aucune autre consommation de `dailyPnl` dans replay.ts
  (vérifié par grep — unique occurrence L706).

## 4. Instrumentation

Aucune nouvelle métrique : `DAILY_LOSS_LIMIT` est déjà instrumenté dans
`riskRejectionReasons` et la re-définition §4 de `spot-prevalidation.md`
s'applique au dénominateur inchangé.

## 5. Implémentation (consumers)

- `packages/backtest/src/replay.ts` :
  - import `resolveDailyRiskWindow`, type `DailyRiskWindow` depuis
    `@dodash/models` ;
  - état `dailyRiskWindow` en tête de run (à côté de `lastTradeAt`) ;
  - résolution par candle avant la boucle d'ordres ;
  - `snapshot.dailyPnl = assessment.dailyPnl` (remplace
    `equityBefore − config.initialCapital`).

## 6. Protocole de vérification (D2'')

Changement comportementel déclaratif → **campagne complète avant/après**
(10 fenêtres × 4 profils, ~52 min par phase) :

1. Phase pré : stash des changements, rebuild models, campagne
   `daily-pnl-fidelity-campaign.ts` → `/tmp/dailypnl-pre.json`.
2. Phase post : unstash, rebuild, campagne → `/tmp/dailypnl-post.json`.
3. Diff bit-à-bit : `totalReturn`, `maxDrawdown`, `winRate`,
   `profitFactor`, `trades`, `riskRejectedCount`, tous `reasonCodes`.

## 7. Critères de verdict (D3'')

- Équivalence économique **bit-identique sur les 40 runs** (INV-P4).
- `DAILY_LOSS_LIMIT` = 0 pré et post partout.
- Tout écart = INVALIDE → analyse dédiée avant toute suite (interdit de
  conclure « mieux » sans modèle).

## 8. Résultats (D3'' — vérifié)

- **Contre-preuve (test de caractérisation)** : contre l'ancien replay,
  `daily-pnl-window.test.ts` échoue (`expected 1 to be 2` — le rejet
  DAILY_LOSS_LIMIT fantôme avale le second trade) ; contre le nouveau,
  il passe. Le test verrouille bien le comportement corrigé.
- **Phase pré** (stash, ancien code) : 40/40 runs, `DAILY_LOSS_LIMIT` = 0
  partout → précondition INV-P4 confirmée empiriquement.
- **Phase post** (nouveau code) : 40/40 runs.
- **Diff bit-à-bit** (`diff` pré/post) : **IDENTIQUE** sur les 40 runs —
  totalReturn, maxDrawdown, winRate, profitFactor, trades,
  riskEvaluationCount, riskRejectedCount et tous reasonCodes.
- **Verdict** : critères §7 remplis. INV-P4 tient : la correction de la
  mesure ne change aucune décision en V1 journalière (INV-P3), elle
  prépare la fidélité pour les timeframes infra-journaliers où la limite
  devient active.
- Logs : `/tmp/dailypnl-pre.log`, `/tmp/dailypnl-post.log` (éphémères).

## 9. Hors périmètre

- Marquage de l'openingEquity au **prix d'open** du candle (nécessiterait
  OHLC intraday ; le marquage à la première évaluation du jour est le
  miroir du live).
- Timeframes infra-journaliers (la fenêtre y devient active — futur
  protocole dédié).
- Kill switch / `killSwitchActive` (déjà false dans le replay, inchangé).
