# Revue du modèle d’exécution Agent

## Revue de l'amendement du 2026-11-21 — Acteur unique et trailing durable

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**.

La revue `trading-safety-corrections.review.md` approuve et vérifie le propriétaire d'exécution, l'acteur XState partagé avec les commandes et le drainage des soumissions possibles. Le calcul du trailing est pur, puis transporté et persisté par `PAPER_PROTECTION_UPDATED`. Les seuils et la comptabilité v7 restent conservés ; la matrice de non-régression et les résultats globaux figurent dans la revue commune.

| Cas | Comportement fermé | Couverture |
| --- | --- | --- |
| Démarrage sans permission | événement refusé par XState | Couvert |
| Commande non authentifiée | refus HTTP avant RPC | Couvert |
| Modification directe du state | `validateStateChange` lève une erreur | Couvert |
| Réveil dupliqué | `ALARM_FIRED` dupliqué est ignoré | Couvert |
| Retry | phase `retrying*`, reprise au réveil suivant | Couvert |
| Crash avant soumission | phase et intention déjà persistées | Couvert |
| Crash après soumission possible | réconciliation obligatoire | Couvert |
| Kill pendant un cycle | annulation ou réconciliation selon la phase | Couvert |
| Échec de persistance | aucun rescheduling avant succès | Couvert |
| État terminal | `failed`/`halted`, reprise uniquement par `RESET` | Couvert |
| Secret/JWT | jamais dans state, SQL ou logs | Couvert |
| Live désactivé ou credentials absents | démarrage refusé, machine inchangée | Couvert par le contrat |
| Clé non-ES256 ou JWT invalide | échec d’autorisation, aucun POST | Couvert par le contrat |
| Rate limit avant acceptation | rejet retryable avec le même `clientOrderId` | Couvert par le contrat |
| Timeout/5xx après début du POST | issue inconnue, jamais un rejet supposé | Couvert par le contrat |
| Crash avant stockage de l’`order_id` | replay idempotent du POST avec le même `clientOrderId` | Couvert par le contrat |
| Ordre Coinbase intermédiaire | réconciliation retryable, aucun fill inventé | Couvert par le contrat |
| Ordre terminal partiellement rempli | portefeuille dérivé uniquement du fill retourné | Couvert par le contrat |
| Permission `trade` absente | réponse Coinbase explicite, ordre rejeté | Couvert par le contrat |

La projection phase → effet est totale pour les phases actives et ne contient
aucune branche pilotée par un texte libre. Le mode paper et le mode live
partagent les mêmes événements ; seuls leurs adapters d’autorisation,
d’exécution et de réconciliation diffèrent.

## Revue complémentaire — DAO #62 (2026-09-26)

Le dernier mark paper est un fait daté conservé hors contexte XState. Seul un
snapshot marché accepté le remplace; une erreur ne rafraîchit jamais son âge.
Le mark persiste source, timeframe, close de bougie et limite de staleness. Un
état legacy sans provenance se normalise à `null`; aucun coût d’acquisition ou
heure de déclenchement n’est utilisé comme substitut.

L’API calcule la qualité à partir du mark stocké et d’un `asOf` courant. Le
reporting paper est séparé de l’entrée dailyRisk transmise au workflow. Aucun
événement, garde ou effet d’ordre XState n’est modifié par ce modèle.

Verdict de modèle : approuvé sous réserve des vérifications listées ci-dessus.

## Implémentation et vérification DAO #62 — 2026-09-26

Les snapshots produit legacy, marques absentes et marques incohérentes sont
normalisés sans inventer de provenance; un mark valide survit à un cycle sans
nouveau snapshot sans rafraîchir son âge. L’API de projection reçoit un `asOf`
explicite et reste séparée des entrées dailyRisk et des transitions XState.

Vérification : tests `models` 430/430, tests `agent` 264/264 et vérifications
TypeScript des trois paquets concernés réussis. Les tests de restauration,
reprise après panne marché et projection API sont inclus dans ces suites.

## Revue complémentaire — persistance des marks de valorisation

Le commentaire Copilot sur la persistance d’un `valuationMark` malformé est
fondé : les deux chemins de cycle écrivaient directement l’objet d’artefact,
alors que le contrat exige une marque acceptée. Le modèle demande une
validation, une copie immuable avant persistance, et une nouvelle validation
du précédent mark avant de le conserver. Cette correction reste une
normalisation de mesure et ne modifie aucun choix ou événement XState.

## Revue — amendement 2026-09-28

Verdict : **APPROUVÉ**. Les quatre points sont des effets ou des projections ;
aucune transition, garde ou événement de `tradingCycleMachine` n'est ajouté.
Le seul champ de contexte machine lu en plus est `attempts.marketData`
(existant). Les champs persistés ajoutés (`schedule.kind`, `schedule.expression`,
`lastMissedDecisionCandleClosedAt`, `artifacts.marketRetry`) sont normalisés
fail-closed à la restauration conformément à la règle « État durable ».

## Revue de l'amendement du 2026-11-18

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**

- **Pureté & Rétrocompatibilité (INV-AR1, INV-AR2)** : `positionQuantities` et `closeFullPositionOnSell` sont des champs optionnels sur `AllocationInput`. Sans eux, `allocateSignals` conserve son comportement V1 exact. Avec eux, les ventes ne sont plus plafonnées à tort par `capitalAvailable` ni supérieures à `positionQuantity`, éliminant les rejets `SELL_EXCEEDS_POSITION` et les résidus bloquants.
- **Isolation Paper (INV-AR3)** : la sortie protectrice SL/TP sur bougie close et le carnet synthétique `LIMIT_PASSIVE` sont strictement bornés à `executionMode === "paper"`. Aucune transition XState de `tradingCycleMachine` n'est modifiée.
- **Anti-pyramidage et sortie asymétrique contrôlée (2026-11-18)** : l'interdiction d'empiler un 2e `BUY` lorsque `closeFullPositionOnSell === true` et `heldQty > minNetQuantity` ainsi que la condition de sortie non protectrice (`rsi >= 55` ou gain latent net `close > averagePrice * 1.0005`) éliminent les sorties précoces à `-15 bps` hors Stop-Loss. Verdict : **APPROUVÉ**.
- **Revue Amendement 2026-11-18 (v2) — Correctifs Risque/SQLite/Cache + Axes 1 & 2** :
  - [x] Exemption des ventes réduisant une position longue (`isPositionReducingSell`) vis-à-vis de `DAILY_LOSS_LIMIT`, `COOLDOWN_ACTIVE`, `ORDER_NOTIONAL_LIMIT`, `POSITION_NOTIONAL_LIMIT` et `GROSS_EXPOSURE_LIMIT`.
  - [x] Index SQLite idempotents et purge bornée aux seules lignes `NO_ACTION` au-delà des 400 plus récentes.
  - [x] Fraîcheur maximale de 30s sur le cache ticker Coinbase en lecture.
  - [x] Filtre de régime directionnel (`BEARISH` / `BULLISH` / `RANGE`) et Breakeven / Trailing Stop reconstruits purement à partir de `indicators` (`plusDi`, `minusDi`, `trendStrength`) et des bougies postérieures à `lastTradeAt`, sans nouvelle table ni mutation d'état XState.
  - Verdict : **APPROUVÉ**.
- **Revue Amendement 2026-11-19 (v3) — Calibration 1m (`BEARISH`, Cooldown 5 min, Sortie `+25 bps`, Sizing `0.4×` sous EMA)** :
  - [x] Aucun nouvel état, événement ou transition XState ; règles purement fonctionnelles dans le filtrage/ajustement des signaux en `paper` + `positionAware`.
  - [x] Le plancher de cooldown post-clôture (`300_000 ms`) ne s'applique qu'aux `BUY` lorsque `positionQuantity === 0` ; les `SELL` protecteurs restent toujours exécutables.
  - [x] Rétrocompatible avec les sessions live existantes sans redémarrage ni perte d'état Durable Object.
  - Verdict : **APPROUVÉ**.
- **Revue Amendement 2026-11-19 (v4) — Filtre Horaire `EMA 60` & Long/Short Symétrique en Paper** :
  - [x] Isolation `live` garantie : `allowShort` vaut `false` par défaut dans les stratégies, l'allocateur, le risque et le broker ; seul `executionMode === "paper"` avec `positionAware === true` l'active.
  - [x] Aucun levier caché : un `SHORT` paper exige `notional + fee <= portfolio.cash`, et aucune inversion directe `LONG <-> SHORT` en un seul ordre n'est permise (clôture vers `FLAT` d'abord, puis cooldown).
  - [x] Les ordres de réduction (`SELL` sur `LONG`, `BUY` sur `SHORT`) sont symétriquement exemptés des limites de perte/cooldown/exposition.
  - [x] Projection `/pnl` et `dashboard-api.ts` alignées sur `positionQuantity` signé et `Math.abs(positionQuantity) * markPrice`.
  - Verdict : **APPROUVÉ**.
- **Revue Amendement 2026-11-20 (v5) — Wide Trailing `V5B` (`>= +75 bps`, recul `max(1,5× ATR, 40 bps)`)** :
  - [x] Ajustement purement paramétrique des seuils de trailing stop dans l'interpréteur `paper`, sans modification de la machine XState ni du schéma persisté.
  - [x] Validé empiriquement en backtest `5m` (`+$103,35` vs `-$53,30`, WR `51,5 %`, Max DD `0,419 %`).
  - Verdict : **APPROUVÉ**.
- **Revue Amendement 2026-11-21 (v6) — Garde anti-micro-sortie (`RSI 75/25` + plancher `+5 bps`)** :
  - [x] Règle pure dans le filtrage des signaux non protecteurs en `paper` ; les Stop-Loss, Take-Profit et Trailing Stop restent prioritaires et inchangés.
  - Verdict : **APPROUVÉ**.

## Revue de l'amendement du 2026-11-21 (v7) — Stop-Loss `MARKET`, tendance multi-horizon, seuils `5m` et comptabilité `SHORT`

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**

- **Pureté et effets** : aucune nouvelle phase, événement ni transition dans `tradingCycleMachine` ; aucun nouvel effet réseau ou stockage. Le choix `MARKET` pour `PAPER_STOP_LOSS` reste une projection pure vers `allocateSignals`.
- **Invariants (`INV-AR4` à `INV-AR7`)** :
  - `PAPER_STOP_LOSS` paye désormais les frais taker + slippage (`MARKET`), éliminant le biais optimiste du carnet synthétique sur les stops d'urgence.
  - Le filtre de tendance (`EMA 180` en `1m`, `EMA 60` en `>= 5m`) s'exécute uniquement sur les bougies déjà présentes (`candleLimit: 200`), sans requête additionnelle, et supprime les entrées contre-tendance `0,4×` mesurées perdantes (`WR 42,4 %`).
  - L'inclusion des frais d'entrée dans `averagePrice` sur `SHORT` restaure l'identité comptable `realizedPnl === Δcash` entre `executePaperOrder` et `projectDashboardPnlHistory` (qui réutilise `previousPortfolio.averagePrice`).
- **Isolation `live` / `perp`** : toutes les règles d'interpréteur sont strictement gardées par `executionMode === "paper" && positionAware` ; `allowShort` reste `false` en `live` spot (`SPOT_SHORT_FORBIDDEN`).
- **Limites acceptées** : sur les positions `SHORT` déjà ouvertes en production avant déploiement, l'ancien `averagePrice` sans frais d'entrée reste porté jusqu'à clôture (écart négligeable de `1 bps` sur un seul trade en cours), puis toutes les nouvelles positions appliquent la symétrie exacte.

## Revue de l'amendement du 2026-11-24 (v8) — Sûreté de clôture, TP ancré/mèche, Anti-Climax Chase & Risk-Based Sizing

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**

- [x] **Sûreté de clôture** : un ordre fermant un `SHORT` ou un `LONG` ne peut plus être bloqué ni par `INSUFFICIENT_CASH` ni par `maxSpreadBps` ni par `minRelativeVolume`.
- [x] **Cohérence carnet TP** : `takeProfitPrice` reste invariant après l'entrée (`carried?.takeProfitPrice`), et l'exécution sur mèche n'est activée que pour les bougies strictement postérieures à `lastTradeAt` (`last.start > lastTradeAt`), évitant tout biais rétroactif sur la bougie d'entrée.
- [x] **Maîtrise du risque par trade** : `combineMode: "MAX"` (optionnel, défaut `"SUM"`) et le plafond `riskBudgetUsd / stopDistPct` normalisent la perte maximale par Stop-Loss indépendamment des pics d'ATR, sans modifier la machine XState ni impacter le mode `live`.

## Revue de l'amendement du 2026-11-25 (v9) — Collatéral Short ségrégué, tolérance IEEE-754, rollover UTC `00:00`, `realizedPnl` persisté & purge SQLite

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**

- [x] **Pureté et ségrégation comptable (`INV-AR8`)** : la déduction `2 * |positionQuantity| * price` retire à la fois le produit de vente short encaissé et la marge `1×` déjà engagée, empêchant tout levier implicite `> 1×` en `paper` sans altérer l'identité d'équité `cash + positionQuantity * markPrice`.
- [x] **Sûreté de clôture IEEE-754 (`INV-AR9`)** : le seuil `1e-12` est cohérent avec `@dodash/risk` (`currentPositionQuantity + 1e-12`) et élimine les faux rejets d'inversion sur poussière flottante.
- [x] **Continuité UTC `00:00` & hygiène SQLite (`INV-AR10`)** : le rollover préalable de `dailyPnl` sur tous les créneaux évite le blocage fantôme du 1er créneau à minuit UTC ; la suppression des `dodash_orders` orphelins maintient l'empreinte SQLite du Durable Object bornée sur le long terme.
- [x] **Isolation `live` / `perp`** : aucune transition de `tradingCycleMachine` ni politique `live` n'est modifiée.

## Revue de l'amendement du 2026-11-26 (v10) — Ancrage Stop `T+0`, borne post-entrée, suppression `0,4×` contre-EMA, exemption clôture `guardExecutionPrice` & cooldown `3×TF`

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**

- [x] **Monotonie et ancrage (`INV-AR11`)** : l'ancrage de `stopLossPrice` sur `carried?.stopLossPrice ?? baseStop` sous `peakGainBps < 75` préserve l'invariant 3 de `trading-safety-corrections.md` (un stop LONG ne baisse jamais, un stop SHORT ne monte jamais) tout en empêchant l'étranglement accidentel lors des baisses d'ATR.
- [x] **Exactitude temporelle (`INV-AR12`)** : l'utilisation de `candle.start + duration > enteredAt` corrige le biais off-by-one dû au stagger/latence (`+0,5 s` à `+8,5 s`) sans jamais réintroduire de biais rétroactif sur la bougie d'entrée (`candle.start + duration <= enteredAt`).
- [x] **Sûreté de clôture (`INV-AR13`)** : exempter uniquement `executionMode === "paper" && isPositionReducingOrder(...)` de `guardExecutionPrice` garantit l'exécution des stops d'urgence en paper tout en laissant intacte la protection `live`/`perp`.
- [x] **Pureté et déterminisme** : `artifacts.triggeredAt` remplace `Date.now()` dans le calcul du cooldown post-clôture ; aucune nouvelle phase ni transition XState.
