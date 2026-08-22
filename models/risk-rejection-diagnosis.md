# Diagnostic — Attribution des rejets du risk engine (`riskRejectionRate` 9-29 %)

Statut : MESURÉ

Cycle diagnostic (aucun changement comportemental ; le but est de
mesurer et d'attribuer, pas de modifier le workflow de trading).

## 1. Contexte et question

La campagne walk-forward (`confidence-sizing-walkforward.md` §6) a
mesuré `riskRejectionRate` ∈ [9,4 %, 28,9 %] sur **les 40 runs**
(10 fenêtres annuelles × 4 profils de calibration), y compris
IDENTITY. Conséquence immédiate : le sélecteur déployé
`selectConfidenceCalibrationProfile` exige `riskRejectionRate = 0`
(raison `RISK_REDUCED`) — un gate **insatisfaisable en l'état**, qui
bloque toute activation du modèle de calibration par la voie
officielle.

Questions :

- **Q1** — Quelle est la répartition des rejets par `reasonCode` ?
- **Q2** — Quels rejets sont structurellement bénignes (ex. SELL à
  plat impossible en spot) vs materialisés (perte d'edge ou kill
  switch cumulatif) ?
- **Q3** — Le gate `riskRejectionRate = 0` du sélecteur est-il
  satisfaisable, ou doit-il être redéfini (décision post-diagnostic) ?

## 2. Mécanique relevée (code existant, inchangé)

- `checkRisk` (`packages/risk/src/risk.ts` L74-138) est **binaire**
  par ordre : `APPROVED` ou `REJECTED { reasonCode }`. Jamais de
  réduction partielle. Codes : `KILL_SWITCH_ACTIVE`,
  `DAILY_LOSS_LIMIT`, `COOLDOWN_ACTIVE`, `SPOT_SHORT_FORBIDDEN`,
  `ORDER_NOTIONAL_LIMIT`, `POSITION_NOTIONAL_LIMIT`,
  `GROSS_EXPOSURE_LIMIT`.
- Replay (`packages/backtest/src/replay.ts` L656-675) : chaque ordre
  alloué passe par `checkRisk` ; un rejet **droppe silencieusement**
  l'ordre (L673) sans trace du motif.
- **Anomalie sémantique candidate** (L665) : `dailyPnl` alimenté
  avec `equityBefore − initialCapital` = PnL **cumulé depuis
  l'origine**, pas journalier. Avec `maxDailyLoss = 1_000` (cli.ts
  L64) et capital 10 000 : dès que l'équity passe sous 9 000, **tout
  ordre est rejeté** (`DAILY_LOSS_LIMIT`) jusqu'à recouvrement —
  comportement de kill switch cumulatif à −10 %, pas de limite
  quotidienne.
- **Divergence de fidélité live/backtest** : `models/daily-risk.ts`
  (source de vérité) définit la sémantique attendue —
  `dailyPnl = equity − openingEquity` de la fenêtre UTC du jour
  (`resolveDailyRiskWindow`), consommée par l'agent live
  (`apps/agent/src/trading-agent.ts` L339/L364). Le replay backtest
  ne l'appelle pas : le backtest n'est pas fidèle au modèle
  daily-risk en vigueur en live.
- Synthèse (`models/backtest-diagnostics.ts` L170-188) :
  `riskEvaluated` = observations avec `allocatedNotional > 0` ;
  rejet = `riskApprovedNotional < allocatedNotional − tolérance`
  (granularité **par décision**, pas par ordre).
- Config V1 (cli.ts L60-68) : `maxOrderNotional` 2 000,
  `maxPositionNotional` 10 000, `maxGrossExposure` 20 000,
  `maxDailyLoss` 1 000, `cooldownMs` 0, `maxDecisionNotional` 2 000,
  capital initial 10 000, `targetSignalNotional` 1 000.

## 3. Hypothèses falsifiables

- **H1 — kill switch cumulatif (`DAILY_LOSS_LIMIT`)** : le rejet
  survient dès `equity ≤ 9 000` et frappe **toutes** les décisions
  tant que l'équity reste sous ce seuil. Prédiction : dominant sur
  les fenêtres/profils à dd > 10 % (THIRD/QUARTER 2016-2018, 2020) ;
  binaire dans le temps (0 % ou ~100 % des décisions d'une période).
- **H2 — SELL à plat (`SPOT_SHORT_FORBIDDEN`)** : les décisions dont
  l'ordre net est SELL avec position nulle sont rejetées. Prédiction :
  présent partout y compris IDENTITY, taux ≈ proportion des décisions
  nettes SELL à plat ; croît avec la fréquence SELL des stratégies.
- **H3 — plafonds de position (`POSITION_NOTIONAL_LIMIT`)** : la
  position excède 10 000 quand l'équité croît au-delà du capital
  initial. Prédiction : réservé aux profils agressifs en années bull
  (QUARTER/THIRD 2016-2018, 2020) ; absent pour IDENTITY.
- **H4 — résiduel nul** : `ORDER_NOTIONAL_LIMIT` (ordres ≤
  `maxDecisionNotional` 2 000 = `maxOrderNotional`), `COOLDOWN`
  (0 ms), `KILL_SWITCH` (false) et `GROSS_EXPOSURE` (≤ 2× position
  ≤ 20 000) quasi inexistants (< 1 % cumulé).

## 4. Modèle d'instrumentation (D1)

Extension **purement observationnelle** des diagnostics :

- `AllocationDiagnosticObservation` (types L11-15) gagne
  `rejectedReasonCodes: readonly RiskRejectionReasonCode[]` — motifs
  des ordres droppés de la décision, dans l'ordre d'évaluation.
- Nouvelle union miroir dans `models/backtest-diagnostics.types.ts` :
  `RiskRejectionReasonCode` (7 littéraux ci-dessus). `models/` est
  autonome (aucune dépendance vers `@dodash/risk`) ; l'alignement
  avec `RiskReasonCode` de `packages/risk` est verrouillé par un
  **test d'assignabilité structurelle bidirectionnelle** (le drift
  casse la compilation).
- `AllocationDiagnostics` (types L40-50) gagne
  `riskRejectionReasons: Readonly<Record<RiskRejectionReasonCode, number>>`
  — compteur par code, **tous les codes présents** (0 si absent),
  granularité **par ordre** (≠ `riskRejectedCount`, par décision —
  documenté, intentionnel).
- Replay : collecte des motifs au moment du drop (L673) ; aucune
  autre modification du chemin d'exécution.
- Validation : `rejectedReasonCodes` est un tableau fini de codes
  valides ; un code n'apparaît qu'une fois par ordre droppé.

### Invariants

- **INV-D1** — Zéro changement comportemental : toute métrique
  économique (returns, trades, equity curve, exits) est
  **bit-identique** avant/après instrumentation. Vérifié par la
  suite de tests existante + re-run baselines 2023/2025 IDENTITY
  (réutilise le contrôle WF2 du walk-forward).
- **INV-D2** — Cohérence agrégée : une décision comptée dans
  `riskRejectedCount` (approved < allocated) possède ≥ 1 entrée dans
  `rejectedReasonCodes` ; une décision non rejetée en possède 0.
- **INV-D3** — Le compteur `riskRejectionReasons` est exhaustif et
  stable : clés = les 7 codes, sans exclusion.

## 5. Protocole de mesure (D2)

- Campagne : 10 fenêtres annuelles 2016→2026 × 4 profils
  (IDENTITY, HALF, THIRD, QUARTER), config V1 bit-identique au
  walk-forward (~40 runs, ~75 s chacun).
- Sortie par run : `riskRejectionRate` global + décomposition par
  raison (part des ordres droppés), médianes
  allocated/approved/requested.
- Contrôles : baseline bit-identique 2023/2025 IDENTITY (WF2) ;
  sanité INV-D2 par run.

## 6. Critères de verdict (D3)

- **Attribution complète** : ≥ 95 % des ordres droppés couverts par
  H1-H3, résiduel H4 < 1 %.
- **Classification** : chaque raison étiquetée bénigne
  structurelle (H2), sémantique déviante (H1 : divergence de
  fidélité live/backtest — le modèle `daily-risk` existe et n'est
  pas consommé par le replay), ou plafond nominal (H3).
- **Décisions sortantes** (hors périmètre de ce cycle, à trancher
  ensuite) : aligner le replay sur `resolveDailyRiskWindow`
  (changement comportemental → cycle complet avec walk-forward),
  révision du gate `riskRejectionRate = 0` du sélecteur, ou
  documentation d'une bénignité.

## 7. Résultats et verdict (campagne D2)

Script : `packages/backtest/scripts/risk-rejection-attribution.ts`
(42 runs ≈ 52 min). Contrôles : WF2 PASS (2023 ret 0,27 %/dd 2,93 %,
2025 ret 3,63 %/dd 3,37 %, bit-identiques → INV-D1) ; INV-D2 : 0
violation sur les 42 runs.

### Q1 — Attribution globale (417 ordres droppés, 40 runs)

| reasonCode | ordres | part |
|---|---|---|
| `SPOT_SHORT_FORBIDDEN` | 384 | 92,09 % |
| `POSITION_NOTIONAL_LIMIT` | 33 | 7,91 % |
| `KILL_SWITCH_ACTIVE` / `DAILY_LOSS_LIMIT` / `COOLDOWN_ACTIVE` / `ORDER_NOTIONAL_LIMIT` / `GROSS_EXPOSURE_LIMIT` | 0 | 0 % |

Par profil : IDENTITY 97 (100 % SPOT_SHORT), HALF 100 (96+4), THIRD
106 (96+10), QUARTER 114 (95+19). `riskRejectionRate` médian par
profil : 16,67 % / 16,67 % / 17,74 % / 19,61 %. Position notional
concentré sur 2016-2018 et 2020 en profils agressifs (dd > 10 %),
absent d'IDENTITY — conforme à la prédiction H3.

### Conclusions par hypothèse

- **H1 (kill switch cumulatif) : FALSIFIÉE.** `DAILY_LOSS_LIMIT` = 0
  sur les 40 runs : sous config V1, l'équity ne passe jamais sous
  9 000. L'anomalie `dailyPnl` cumulatif (replay L665) reste un
  **défaut latent de fidélité** live/backtest — non déclenché ici,
  mais actif en tout régime où l'équity perd > 10 % depuis l'origine
  (la correction relève d'un cycle séparé, cf. §6 décisions
  sortantes).
- **H2 (SELL à plat) : CONFIRMÉE, cause dominante.** Présent sur
  **toutes** les fenêtres y compris IDENTITY (97/97 ordres
  IDENTITY). Floor observé : 5,77 % (2020) à 23,08 % (2022).
- **H3 (plafond position) : CONFIRMÉE, secondaire.** 33 ordres,
  exclusivement profils agressifs (QUARTER 19, THIRD 10, HALF 4) en
  années bull — le plafond nominal fait son travail.
- **H4 (résiduel) : CONFIRMÉE.** Strictement 0.

Attribution H1+H2+H3 = 417/417 (100 % ≥ 95 %) → critère D3 PASS.

### Q2 — Classification

- `SPOT_SHORT_FORBIDDEN` — **bénin structurel** : l'ordre net est
  SELL avec position nulle ; l'intention n'est pas exécutable en
  spot (le broker live refuserait identiquement). Aucun edge perdu
  par rapport à l'exécutable. C'est un **défaut du pipeline amont**
  (le signal SELL à plat ne devrait pas devenir un ordre) plutôt
  qu'un rejet de risk significatif.
- `POSITION_NOTIONAL_LIMIT` — **plafond nominal matérialisé** :
  sizing agressif qui bute sur `maxPositionNotional` 10 000 ;
  comportement attendu et désiré du risk engine.
- `DAILY_LOSS_LIMIT` — **sémantique déviante** (non observée sous
  V1, cf. H1) : la sémantique cumulative du replay diverge du modèle
  `daily-risk` en vigueur en live.

### Q3 — Verdict sur le gate sélecteur

Le gate `riskRejectionRate = 0` est **structurellement
insatisfaisable** : le floor SPOT_SHORT existe dès IDENTITY (9-23 %
selon la fenêtre, 100 % des rejets IDENTITY). La métrique actuelle
compte des **intentions non exécutables** comme des rejets de risk.
Tant que le pipeline émet des SELL à plat, aucune calibration ne
peut passer le sélecteur par la voie officielle.

### Décisions sortantes (hors périmètre, cycles futurs)

1. **Pré-validation spot amont** — ne pas émettre d'ordre SELL à
   plat (modéliser la permission spot comme `resolveRegimePermission`
   le fait pour le régime). Changement comportementel → cycle
   complet Model→Review→Implement→Verify + walk-forward.
2. **Alignement du replay sur `resolveDailyRiskWindow`** — corriger
   la sémantique `dailyPnl` (fidélité live/backtest). Changement
   comportementel → cycle complet.
3. **Redéfinition du gate sélecteur** — après 1, le re-déploiement
   de `riskRejectionRate = 0` devient satisfaisable ; sinon le gate
   doit exclure les rejets bénins structurels.

## 8. Hors périmètre

- Toute modification de `checkRisk`, de la config risk, ou du
  comportement du replay.
- Toute modification du sélecteur `selectConfidenceCalibrationProfile`.
- Le sizing conditionné par régime (cycle suivant, séparé).
