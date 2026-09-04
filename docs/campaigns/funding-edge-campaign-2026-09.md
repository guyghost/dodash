# Campagne d'edge funding — DAO #30 (2026-09)

Statut : **TERMINÉE — edge non démontré aux seuils figés ; activation non
recommandée.**
Protocole : `models/funding-edge-campaign.md` (pré-enregistré, commit
`bd4a561`, **avant** toute collecte — INV-C1).
Revue : `models/funding-edge-campaign.review.md`.
Périmètre : lecture-seule — aucun code de trading, aucune permission
touchés (INV-C2). Toutes les données de ce rapport sont réelles (INV-C3).

## 1. Manifeste

| Élément | Valeur |
| --- | --- |
| Fenêtre H12 | `[2025-09-01T00:00:00Z, 2026-09-01T00:00:00Z)` — 365 bougies `ONE_DAY` |
| Sous-fenêtres | F1 `[09-01, 12-01)` F2 `[12-01, 03-01)` F3 `[03-01, 06-01)` F4 `[06-01, 09-01)` R30 `[08-02, 09-01)` (protocole §2) |
| Funding | Hyperliquid `POST /info {type:"fundingHistory", coin:"BTC"}`, coin de la configuration perp de référence |
| Prix | Coinbase spot `BTC-USD`, `ONE_DAY` (miroir, convention #27) |
| Rejeu | `packages/backtest` chemin non préparé, coût de funding appliqué aux 4 runs (INV-C5) |
| Config | capital 10 000, notional signal 1 000, risque V1 (2000/10000/20000/1000, SL 150 bps, TP 300 bps), frais 6 bps, slippage 2 bps, protective `NONE`, sans filtre de régime, calibration `IDENTITY` (protocole §4) |
| Runs | `funding-trend` (seuil 5e-5) vs `rsi-reversion` (30/70), `ema-cross`, `breakout` (lookback 20) + benchmark buy-and-hold |

Scripts : `packages/backtest/scripts/collect-funding-history.ts` (collecte),
`packages/backtest/scripts/funding-edge-walkforward.ts` (rejeu) —
reproductibles tels quels.

## 2. Données et provenance (INV-C4)

| Fixture | Contenu | Provenance |
| --- | --- | --- |
| `packages/backtest/fixtures/dao30-funding-btc.json` | 8 760 échantillons horaires (= 365 × 24 h, aucun trou) | 19 requêtes bornées (≤ 1 MiB, timeout 10 s, coercition, rejet entier hors spec) ; collecté le 2026-09-04T08:53:59Z ; **SHA-256 `00b05215f314830d6aebd34c23d621bf7beeb8c0be8f76a68700202fc31e1a6a`** |
| `packages/backtest/fixtures/dao30-price-btc-usd.json` | 365 bougies `ONE_DAY` BTC-USD | endpoint `api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles` ; collecté le 2026-09-04T08:53:59Z ; **SHA-256 `8c7fa43a370781505ab6dda2665168f7059cbaa217805aa42ba43ad1038541cd`** |

Fichiers de provenance `.provenance.json` adjacents (endpoint, fenêtre,
horodatage, nombre d'appels, paramètres bornés, SHA-256) ; les deux
scripts revérifient le SHA-256 des fixtures à la lecture. Couverture
journalière : 365/365 bougies avec ≥ 1 observation de funding (validation
fail-closed avant écriture).

Notes de collecte (détails opérationnels, aucune retouche de fenêtre,
métrique ou seuil — INV-C1) :

- les instants de funding Hyperliquid portent une gigue milliseconde
  (ex. `23:00:00.129Z`) : la dernière page paginée peut être vide dans
  la dernière heure de la fenêtre. Règle appliquée (plus stricte que le
  rejet brut) : page vide rejetée sauf à moins d'une heure de la fin,
  couverture journalière validée bougie par bougie dans tous les cas ;
- 8 760 enregistrements couvrent exactement la fenêtre : aucune donnée
  manquante, aucune troncature.

## 3. Résultats H12 — 12 mois, net de funding (protocole §5)

| Run | Sharpe | Drawdown max | Trades | Funding payé | PnL | Retour |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **funding-trend** | 0 | 0 % | **0** | $0.00 | $0.00 | 0 % |
| rsi-reversion | −0.078 | 35.06 % | 30 | $12.78 | −$1 037.64 | −10.38 % |
| **ema-cross (baseline max)** | **+0.241** | 0.018 % | 13 | $0.007 | +$0.48 | +0.005 % |
| breakout | −0.211 | 0.209 % | 28 | $0.065 | −$4.64 | −0.046 % |
| buy-and-hold | — | — | 1 | — | −$2 748.14 | −27.48 % |

Résultat dominant : **`funding-trend` n'a émis aucun signal en 12
mois** — HOLD permanent. Ce n'est pas un défaut d'alimentation : la
série atteint l'indicateur (suffixe 72, chemin non préparé,
`replay.ts:fundingInputFor`). La mesure l'explique :

| Statistique sur les données réelles | Valeur |
| --- | --- |
| Taux journalier BTC (min / max) | −1,74e-5 / +2,68e-5 |
| `fundingAvg` glissant 72 j — max \|valeur\| | **1,18e-5** |
| `fundingAvg` — quantiles \|valeur\| p50 / p90 / p99 | 6,6e-6 / 1,0e-5 / 1,2e-5 |
| Jours où \|`fundingAvg`\| ≥ seuil figé 5e-5 | **0 sur 294** |

L'amplitude réelle du funding Hyperliquid BTC est restée ≈ 4,2× sous le
seuil d'entrée figé (#27, justifié a priori comme 4× la base) : la
stratégie n'a jamais été autorisée à agir.

### Stabilité par sous-fenêtre (Sharpe / drawdown / trades)

| Run | F1 | F2 | F3 | F4 | R30 |
| --- | --- | --- | --- | --- | --- |
| funding-trend | 0 / 0 % / 0 | 0 / 0 % / 0 | 0 / 0 % / 0 | 0 / 0 % / 0 | 0 / 0 % / 0 |
| rsi-reversion | −0,89 / 8,3 % / 16 | −1,36 / 30,3 % / 14 | +0,96 / 11,9 % / 0 | +0,69 / 18,0 % / 0 | +5,42 / 3,3 % / 0 |
| ema-cross | −2,07 / 0,002 % / 1 | −2,29 / 0,008 % / 2 | +0,41 / 0,007 % / 6 | +1,19 / 0,009 % / 4 | +4,64 / 0,004 % / 3 |
| breakout | −2,31 / 0,062 % / 5 | −2,69 / 0,097 % / 6 | +0,04 / 0,088 % / 8 | +0,92 / 0,067 % / 9 | +3,28 / 0,067 % / 3 |

## 4. Seuils de décision recommandés (protocole §6) — évaluation

| # | Seuil | Mesure | Verdict |
| --- | --- | --- | --- |
| S1 | Sharpe H12 ≥ baseline max + 0,25 | −0,241 vs +0,241 | **ÉCHOUÉ** |
| S2 | ≥ 30 trades H12 | 0 | **ÉCHOUÉ** |
| S3 | DD ≤ baseline max + 0,05 | 0 vs 0,018 | satisfait (dégénéré — zéro exposition, sans valeur d'information) |
| S4 | différentiel ≥ 0 sur ≥ 3 trimestres ∧ R30 | positif sur F1, F2 seulement ; R30 −4,64 | **ÉCHOUÉ** |
| S5 | Sharpe H12 ≥ 0 | 0 | satisfait (dégénéré — même remarque) |

**Grille du protocole : S1 ∧ S2 ∧ S3 ∧ S4 ∧ S5 = faux → activation non
recommandée.** S3/S5 « satisfaits » le sont trivialement par absence
d'exposition : ils ne constituent aucune preuve d'edge.

## 5. Lecture

1. **Le résultat mesuré est la non-activité.** Aux seuils figés a priori
   (#27), le funding BTC Hyperliquid n'a jamais été assez chargé pour
   autoriser un signal sur 12 mois. L'edge de la stratégie est donc
   **non démontré** — ni établi, ni réfuté : la stratégie n'a jamais
   pris de risque, elle n'a rien coûté (funding payé $0) et rien
   rapporté.
2. **L'hypothèse « seuil trop haut » est une nouvelle hypothèse.** Toute
   baisse de `enterThreshold` (ex. vers l'amplitude observée p90/p99)
   est un changement de seuil après observation : interdite par INV-C1
   sur ce protocole. Elle exige un nouveau protocole pré-enregistré
   (commit avant nouvelle observation), avec la justification a priori
   de son seuil et la même discipline anti-retouche.
3. **Les baselines prix-seul ont été mesurées sur la même fenêtre à
   titre de comparaison** : aucune ne montre d'edge net convaincant
   (Sharpe −0,08 / +0,24 / −0,21, deux sur trois en perte, buy-and-hold
   −27,5 %) ; leurs signes par trimestre sont volatils. Rien ici ne
   suggère qu'un relâchement du seuil funding produirait mécaniquement
   un edge.

## 6. Écarts au protocole

- **Aucun écart** sur les fenêtres, la configuration de rejeu, les
  métriques, les conventions de segment ou les seuils.
- Détail de collecte documenté §2 (gigue milliseconde, page vide de
  dernière heure) : règle appliquée plus stricte que le rejet brut ;
  couverture journalière 365/365.
- Observation hors périmètre (consignée, non corrigée) : l'exposition
  effective d'`ema-cross` est très faible (turnover 0,002, drawdown
  0,018 %) — comportement du cœur de rejeu existant (allocation,
  rabotage cash/limites), identique pour tous les runs ; à étudier dans
  un cycle dédié si jugé utile.

## 7. Points ouverts

- Nouveau protocole pré-enregistré si l'on veut tester un seuil
  d'entrée calibré sur l'amplitude observée (recommandation : le faire
  sur une fenêtre **future** pour préserver une lecture OOS).
- La question de l'exposition effective des baselines (turnover faible)
  est un suspect de diagnostic distinct, hors périmètre #30.
- Extension ETH ou multi-coins : hors périmètre (protocole §10).

## 8. Reproductibilité

```bash
npx tsx packages/backtest/scripts/collect-funding-history.ts   # refetch + provenance
npx tsx packages/backtest/scripts/funding-edge-walkforward.ts  # rejeu + seuils
```

Vérifications : `pnpm check`, `pnpm test`, `pnpm build`, `pnpm lint`
sans nouveau warning (livrées avec le commit de cette campagne).
