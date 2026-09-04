# Campagne d'edge funding — protocole v2 : calibration → validation hors-échantillon (DAO #35)

Statut : PROTOCOLE FIGÉ — phase A calibrée et annexée sur le dataset
campagne-1 ; **phase B non collectée à ce commit** (INV-C1 : l'historique
git fait foi — ce commit précède tout fetch out-of-sample).

## 1. Contexte et objet

La campagne v1 (DAO #30, rapport
`docs/campaigns/funding-edge-campaign-2026-09.md`) s'est soldée par un
verdict **non informatif** : aux seuils figés a priori (#27,
`enterThreshold = 5e-5`), la stratégie `funding-trend` n'a émis aucun
signal en 12 mois — l'amplitude réelle du funding BTC Hyperliquid est
restée ≈ 4,2× sous le seuil. Le rapport v1 (§5.2, §7) a qualifié
l'hypothèse « seuil trop haut » de **nouvelle hypothèse** exigeant un
nouveau protocole pré-enregistré avant toute nouvelle observation, avec
la même discipline anti-retouche. Le présent protocole est ce nouveau
protocole (hypothèse **H2**).

**H2 (pré-enregistrée)** : à un seuil d'entrée **calibré sur
l'amplitude réellement observée** du funding (top décile de
`|fundingAvg|`), la double porte de `funding-trend` (models/
funding-rate-strategy.md §5) produit des trades et un edge net de
funding mesurable **hors-échantillon**.

Objet : mesurer, rien d'autre. Périmètre **strictement lecture-seule**
(INV-C2) : aucun changement de permission, aucun code de trading, aucun
branchement nouveau ; `funding-trend` reste déniée en runtime pendant
toute la campagne. La décision d'activation reste l'objet d'une
proposition séparée évaluée contre le rapport (INV-C6).

## 2. Deux phases, séquence sacrée

| Phase | Statut au commit du présent protocole | Données autorisées |
| --- | --- | --- |
| **A — calibration (in-sample)** | figée, annexée (§3) | dataset campagne-1 exclusivement (`dao30-*`, fenêtre `[2025-09-01, 2026-09-01)`) |
| **B — validation (out-of-sample)** | **non collectée** (§4) | fenêtre **nouvelle**, collectée **après** ce commit, jamais vue en phase A |

- **INV-C1 (séquence sacrée)** : la calibration et les seuils de la
  grille §4 sont commités **avant** la première collecte OOS ;
  l'historique git en fait foi (commit protocole daté < horodatage de
  collecte). Toute retouche des seuils, fenêtres, métriques ou
  conventions après observation de données OOS = nouveau protocole.
- **INV-C7 (itération unique)** : le seuil §3 n'est **jamais
  recalibré**. La grille §4 est évaluée **une seule fois**, sur la
  première fenêtre OOS atteignant l'évaluabilité A0. Validation échouée
  ⇒ **sujet clos** jusqu'à de nouvelles données, et uniquement sous un
  nouveau protocole pré-enregistré (pas de v3 tacite). Un état EN
  ATTENTE (A0 non atteint) n'épuise pas la règle : les scripts §8
  restent prêts, la grille reste simplement non évaluée.

## 3. Phase A — calibration (figée, annexée)

Dataset : fixtures campagne-1 `packages/backtest/fixtures/dao30-*`
(provenance SHA-256 v1). La distribution complète est annexée au
protocole dans `models/funding-edge-campaign-v2.annexe-calibration.json`
(générée exclusivement par
`packages/backtest/scripts/funding-edge-calibration-v2.ts` — toute
édition manuelle est un écart ; ré-exécution = reproduction bit à bit).

| Élément | Valeur figée |
| --- | --- |
| Quantité calibrée | `|fundingAvg|` — SMA 72 jours causale (FUNDING_AVG_PERIOD, suffixe aligné bougies) |
| Jours de décision | 294 (365 − 71 d'échauffement) |
| Règle | quantile **p90**, méthode du rang le plus proche (`h = ⌈p/100 × N⌉`, sans interpolation) |
| **Seuil d'entrée calibré** | **`enterThreshold = 1,010617245370372e-5`** |
| Jours traversés in-sample | 30/294 — **0 longCarry, 30 shortCrowding** |
| Distribution `|fundingAvg|` | min 2,17e-7 · p50 6,64e-6 · p75 8,88e-6 · **p90 1,01e-5** · p95 1,14e-5 · p99 1,18e-5 · max 1,18e-5 |
| Signaux in-sample au seuil calibré | 29 SELL, 265 HOLD, **0 BUY** |
| Rejeu in-sample (config §4) | funding-trend : 0 trade, Sharpe 0, DD 0 % — baselines inchangées vs v1 (rsi −0,078 / ema +0,241 / breakout −0,211 ; buy-and-hold −27,48 %) |

Justification a priori du choix p90 (figée avant le rejeu au seuil
calibré) : amplitude significative (~10 % des jours de décision),
fréquence compatible avec une validation annuelle (~30 événements
attendus), et candidate explicitement nommée par le rapport v1 (§7)
**avant toute donnée nouvelle**. p99 (3 événements/an) aurait rendu la
validation improbable ; p50 (147 jours/an) aurait dégradé la
sélectivité de la porte.

Constat consigné (fait in-sample, annexé tel quel) : le funding BTC
Hyperliquid est resté **positif sur toute la fenêtre campagne-1**
(`fundingAvg` signé ∈ [+2,17e-7 ; +1,18e-5]) — la branche longCarry
(`BUY`, requiert `fundingAvg ≤ −T`) n'a jamais pu s'autoriser ; seuls
29 signaux SELL (shortCrowding + EMA bearish) ont été produits, sans
remplissage (long-only, vente à découvert inexecutable). Le rejeu
in-sample au seuil calibré est donc dégénéré (0 trade) **par structure
du régime de signe du funding**, non par hauteur de seuil. Ce constat
ne modifie rien : H2 est testée hors-échantillon, où le régime de signe
peut différer — c'est précisément l'objet de la phase B.

## 4. Phase B — validation hors-échantillon (figée, non exécutée à ce commit)

### 4.1 Fenêtre et collecte

- Fenêtre OOS : `[2026-09-01T00:00:00Z, M)` où `M` = dernier minuit UTC
  écoulé à l'instant de collecte (alignement §2 v1). Début = fin exacte
  du dataset campagne-1 (contiguïté).
- Collecte : `packages/backtest/scripts/collect-funding-history-v2.ts` —
  mêmes bornes #27/#30 que v1 (réponse ≤ 1 MiB, timeout 10 s, coercition
  chaîne→nombre, rejet entier hors spec, pagination ≤ 500, couverture
  journalière validée bougie par bougie avant écriture), fixtures
  versionnées `packages/backtest/fixtures/dao35-*-oos.json` +
  provenance (endpoint, fenêtre, horodatage, nombre d'appels, SHA-256).
- **INV-C3** : données réelles ou rien — échec de collecte ⇒ état EN
  ATTENTE, jamais de fenêtre compressée ni de donnée fabriquée.

### 4.2 Évaluabilité A0

La grille n'est évaluée que si la fenêtre OOS contient **≥ 90 bougies
quotidiennes complètes** avec couverture funding (un trimestre v1 — la
plus petite granularité de lecture d'un Sharpe dans le protocole v1 —
et ≥ la période d'indicateur la plus longue, 72). Sinon : état
**EN ATTENTE** — aucun verdict, protocole et scripts prêts (INV-C7).

### 4.3 Rejeu (config v1 §4 reprise à l'identique — INV-C5)

- Préfixe d'échauffement : les **90 dernières bougies campagne-1**
  (bougies + taux de funding), état d'indicateurs uniquement ;
  équité initiale 10 000 au début du préfixe ; les runs entrent dans la
  fenêtre OOS avec l'état (position, équité) issu du préfixe — miroir
  d'un passage live. Aucune décision ni métrique n'est prélevée sur le
  préfixe.
- Rejeu causal unique sur `[préfixe ‖ OOS]`, chemin non préparé, coût
  de funding appliqué aux 4 runs ; métriques OOS selon les conventions
  de segment §5 v1 (Sharpe √252 n−1, drawdown pic local, trades par
  `fill.executedAt`), fenêtre de segment = la fenêtre OOS.
- Runs : `funding-trend` au seuil calibré §3, `rsi-reversion` (30/70),
  `ema-cross`, `breakout` (lookback 20) + benchmark buy-and-hold OOS.
- Script : `packages/backtest/scripts/funding-edge-oos-v2.ts` (re-vérifie
  le seuil contre l'annexe — tout écart est fatal).

### 4.4 Grille de verdict mécanique (figée)

Notations : S = Sharpe OOS, DD = drawdown OOS, N = trades OOS ;
« baseline max » = max de S sur les 3 legacy figées.

| # | Seuil | Justification a priori |
| --- | --- | --- |
| A1 | S(funding-trend) ≥ S(baseline max) + **0,25** | identique v1 S1 : un différentiel inférieur au bruit d'échantillon n'autorise aucune décision |
| A2 | N(funding-trend) ≥ **⌈30 × joursOOS / 365⌉** | identique v1 S2 en intensité (30 trades/an), mécaniquement mise à l'échelle de la fenêtre |
| A3 | DD(funding-trend) ≤ DD(baseline max) + **0,05** | identique v1 S3 : l'edge ne se paie pas en +5 points de drawdown |
| A4 | S(funding-trend) ≥ **0** | identique v1 S5 : non-destructivité après coûts |

**Verdict = A1 ∧ A2 ∧ A3 ∧ A4** (évalué une seule fois, si A0). Écart
assumé vs grille v1 et consigné : **S4 (stabilité par folds) non
reprise** — une fenêtre OOS unique n'est pas découpée en folds ; la
stabilité inter-fenêtres relèverait d'un nouveau protocole. Les seuils
« satisfaits par dégénérescence » (0 trade) restent sans valeur
d'information (lecture v1 §4, reconduite).

## 5. Métriques

Inchangées (§5 v1) : Sharpe net de funding (`metrics.sharpe`, √252),
drawdown maximal, nombre de trades (`trades.length`), coût de funding
(`fundingPaid`, indicatif hors grille en phase B — le cœur de rejeu ne
l'impute pas par segment), PnL/retour/turnover ; conventions de segment
§5 v1 pour la fenêtre OOS.

## 6. Rapport et écarts

Le rapport versionné (`docs/campaigns/`) consigne : le rappel du
protocole (commit du présent fichier), le résumé de calibration + SHA
de l'annexe, le manifeste de collecte OOS (fenêtre, sources, SHAs,
horodatages), les métriques brutes, l'évaluation mécanique de la grille
(A0 d'abord), et **tout écart au protocole consigné comme tel**. Un
verdict VALIDE ou ÉCHOUÉ est final (INV-C7). Un état EN ATTENTE
documente la fenêtre collectée (constat brut hors verdict), les scripts
prêts et la condition de ré-exécution (A0), sans retouche d'aucune
constante.

## 7. Invariants

| # | Invariant |
| --- | --- |
| INV-C1 | **Séquence sacrée** : calibration + seuils + grille figés par un commit **antérieur** à toute collecte OOS ; l'historique git fait foi. Toute retouche après observation = nouveau protocole pré-enregistré. |
| INV-C2 | Lecture-seule : aucune permission, aucun code de trading, aucun branchement ; `funding-trend` déniée en runtime pendant toute la campagne. |
| INV-C3 | Données réelles ou rien : aucune donnée synthétique ; collecte fail-closed ; échec ⇒ EN ATTENTE avec protocole et scripts prêts. |
| INV-C4 | Provenance : toute donnée du rapport porte endpoint, fenêtre, horodatage et SHA-256 ; un résultat sans provenance n'est pas un backtest valide. |
| INV-C5 | Comparabilité : même bougies, même config, même série de coût pour tous les runs comparés ; toute asymétrie est un écart consigné. |
| INV-C6 | La campagne ne décide rien : les seuils §3/§4 sont des entrées ; seule une proposition séparée peut activer. |
| INV-C7 | **Itération unique** : aucun recalibrage après la phase A ; grille évaluée une seule fois (première fenêtre A0) ; échec ⇒ sujet clos jusqu'à nouvelles données sous nouveau protocole. |

## 8. Livrables et vérification

- **Commit 1 (celui-ci)** : `models/funding-edge-campaign.md` +
  `.review.md` + annexe de calibration
  (`models/funding-edge-campaign-v2.annexe-calibration.json`) + 3
  scripts (`funding-edge-calibration-v2.ts`,
  `collect-funding-history-v2.ts`, `funding-edge-oos-v2.ts`) —
  **avant tout fetch OOS** (INV-C1).
- Phase B : fixtures `dao35-*-oos` (si collecte réussie), puis rejeu.
- **Commit 2** : rapport `docs/campaigns/` (verdict mécanique ou EN
  ATTENTE, écarts consignés, recommandation pour la future proposition
  d'activation).
- Vérifications : `pnpm check`, tests des paquets touchés, `pnpm build`,
  `pnpm lint` sans nouveau warning. Aucun changement de code de
  production : scripts, annexe et fixtures sont des artefacts de
  campagne.

## 9. Hors périmètre

Inchangé (§10 v1) : toute activation ; balayage des seuils ou de la
période (le seuil §3 est dérivé une fois, par la règle figée — ce n'est
pas un balayage) ; short perp, levier, sizing par amplitude (rejeu
long-only, `TARGET_SIGNAL_NOTIONAL` uniforme) ; ETH ou tout autre coin.
Une variante = nouvelle hypothèse, nouveau protocole pré-enregistré.
