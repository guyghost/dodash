# Campagne d'edge funding v2 — calibration → validation OOS (DAO #35, 2026-09)

Statut : **EN ATTENTE de données — fenêtre out-of-sample trop courte pour
un verdict** (protocole et scripts prêts ; itération unique préservée,
INV-C7).
Protocole : `models/funding-edge-campaign.md` (v2, pré-enregistré, commit
`760a52a`, **avant** toute collecte OOS — INV-C1).
Revue : `models/funding-edge-campaign.review.md` (v2).
Annexe de calibration :
`models/funding-edge-campaign-v2.annexe-calibration.json`
(SHA-256 `63f552ae261d2a2ccef4651f52180aa8b4b4530192aca2b09b60b721141be67b`).
Périmètre : lecture-seule — aucun code de trading, aucune permission
touchés (INV-C2). Toutes les données de ce rapport sont réelles (INV-C3).

## 1. Séquence sacrée (INV-C1) — preuve par l'historique git

| Étape | Commit / horodatage | Contenu |
| --- | --- | --- |
| 1. Protocole v2 figé | `760a52a` (2026-09-04, avant 10:07:49Z) | modèle v2 + revue + **annexe de calibration in-sample** + 3 scripts — aucun artefact OOS |
| 2. Collecte OOS | 2026-09-04T10:07:49Z | fixtures `dao35-*-oos` + provenance SHA-256 |
| 3. Rejeu + verdict mécanique | 2026-09-04 (ce rapport) | **EN ATTENTE** — A0 non atteint |

La phase A n'a lu que le dataset campagne-1 (`dao30-*`, fenêtre close
`[2025-09-01, 2026-09-01)`) ; la fenêtre OOS démarre à cette borne
exacte — aucune donnée OOS n'a pu entrer en calibration par construction
temporelle.

## 2. Phase A — calibration (résumé ; détail annexé)

| Élément | Valeur figée |
| --- | --- |
| Règle | quantile **p90** (rang le plus proche, sans interpolation) de `|fundingAvg|` SMA-72 causale sur les 294 jours de décision de la campagne-1 |
| **Seuil d'entrée calibré** | **`enterThreshold = 1,010617245370372e-5`** (vs 5e-5 figés #27) |
| Distribution `|fundingAvg|` in-sample | min 2,17e-7 · p50 6,64e-6 · p75 8,88e-6 · **p90 1,01e-5** · p95 1,14e-5 · p99 1,18e-5 · max 1,18e-5 |
| Jours traversés in-sample | 30/294 — **0 longCarry, 30 shortCrowding** |
| Signaux in-sample au seuil calibré | 29 SELL, 265 HOLD, **0 BUY** |
| Rejeu in-sample (config §4) | funding-trend : 0 trade, Sharpe 0 ; baselines identiques au rapport v1 (contrôle de cohérence) |

**Constat consigné (fait in-sample, aucun retouche déduite)** : le
funding BTC Hyperliquid est resté **positif sur toute la campagne-1**
(`fundingAvg` signé ∈ [+2,17e-7 ; +1,18e-5]) — la branche longCarry
(`BUY`) n'a jamais pu s'autoriser ; les 29 signaux SELL (shortCrowding
+ EMA bearish) n'ont pas rempli (long-only, vente à découvert
inexécutable). Le rejeu in-sample au seuil calibré est donc dégénéré
**par structure du régime de signe**, non par hauteur de seuil. H2 est
précisément testée hors-échantillon, où ce régime peut différer.

## 3. Phase B — collecte out-of-sample (INV-C4)

| Fixture | Contenu | Provenance |
| --- | --- | --- |
| `packages/backtest/fixtures/dao35-funding-btc-oos.json` | 72 échantillons horaires (= 3 × 24 h, aucun trou) | `POST api.hyperliquid.xyz/info {type:"fundingHistory", coin:"BTC"}`, 2 requêtes bornées (≤ 1 MiB, timeout 10 s) ; collecté le 2026-09-04T10:07:49.700Z ; **SHA-256 `e5a129f127a41314614346b0df5b755bc7603453156255b4754601168d90e1ab`** |
| `packages/backtest/fixtures/dao35-price-btc-usd-oos.json` | 3 bougies `ONE_DAY` BTC-USD Coinbase | `api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles` ; collecté le 2026-09-04T10:07:49.701Z ; **SHA-256 `f71a2301597a650b77131686a349992a438c7c144690a606ad697589c9f3f537`** |

Fenêtre OOS : `[2026-09-01T00:00:00Z, 2026-09-04T00:00:00Z)` — **3
jours** (dernier minuit UTC écoulé à la collecte ; seules des bougies
complètes). Couverture journalière 3/3 validée bougie par bougie avant
écriture (fail-closed).

## 4. Verdict mécanique — A0 non atteint ⇒ EN ATTENTE

| # | Règle | Mesure | Verdict |
| --- | --- | --- | --- |
| A0 | fenêtre OOS ≥ 90 bougies complètes couvertes | 3 / 90 | **NON ATTEINT** |
| A1–A4 | grille §4.4 (edge, activité, risque, non-destructivité) | — | **non évaluée** (conformément au protocole : évaluation unique réservée à la première fenêtre ≥ A0) |

3 jours de décision ne peuvent produire aucun verdict informatif :
fréquence attendue au seuil calibré ≈ 30 traversées/365 jours ⇒ ~0,25
événement attendu sur 3 jours ; un Sharpe de segment y serait du pur
bruit. La grille n'est **pas** évaluée — l'itération unique (INV-C7)
n'est pas consommée.

**Constat brut hors verdict** (descriptif, aucune valeur de décision) :
les 3 taux journaliers observés sont positifs (+1,25e-5, +1,25e-5,
+1,07e-5 ; un seul échantillon horaire négatif sur 72, −2,06e-6) et
`fundingAvg72` entre dans la fenêtre OOS à 9,34e-6 → 9,49e-6 : **sous**
le seuil calibré (aucune autorisation shortCrowding) et **positif**
(aucune autorisation longCarry) — le régime de signe de la campagne-1
persiste à ce jour, mais la fenêtre est sans valeur d'inférence.

## 5. Écarts au protocole

- **Aucun écart** : fenêtre, bornes de collecte (#27/#30), config de
  rejeu, conventions de segment, grille et seuils appliqués tels que
  figés au commit `760a52a`. Le seuil implémenté est re-vérifié contre
  l'annexe à chaque exécution (tout écart est fatal).
- Note de collecte (détail opérationnel, plus strict que le rejet
  brut) : règle page-vide de dernière heure héritée de v1 (gigue
  milliseconde) ; couverture 3/3.

## 6. Recommandation pour la future proposition d'activation

**Aucune activation recommandable à ce stade** — il n'existe aucun
verdict OOS. La discipline reste :

1. **Ne rien recalibrer** (INV-C7) : le seuil 1,010617245370372e-5 et
   la grille A1–A4 restent figés tels qu'annexés.
2. **Ré-exécuter la phase B quand la fenêtre le permet** : dès que
   `[2026-09-01, minuit UTC courante)` atteint 90 bougies (au plus tôt
   le 2026-11-29), ré-exécuter les deux scripts §8 — collecte (nouvelle
   fixture versionnée + provenance) puis rejeu/verdict mécanique unique.
   Le verdict résultant (VALIDÉ ou ÉCHOUÉ) sera final : en cas d'échec,
   le sujet est clos jusqu'à de nouvelles données **sous un nouveau
   protocole pré-enregistré** (pas de v3 tacite).
3. Toute future proposition d'activation s'évaluera exclusivement
   contre ce verdict — la campagne elle-même ne décide rien (INV-C6).

## 7. Reproductibilité

```bash
# Phase A (annexe, reproduction bit à bit)
npx tsx packages/backtest/scripts/funding-edge-calibration-v2.ts
# Phase B — collecte OOS (nouvelle fixture versionnée + provenance)
npx tsx packages/backtest/scripts/collect-funding-history-v2.ts
# Phase B — rejeu + verdict mécanique unique
npx tsx packages/backtest/scripts/funding-edge-oos-v2.ts
```

Vérifications : `pnpm check`, tests des paquets touchés, `pnpm build`,
`pnpm lint` sans nouveau warning (livrées avec le commit de ce rapport).
