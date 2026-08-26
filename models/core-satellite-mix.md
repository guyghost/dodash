# Diagnostic mix core-satellite — baseline holding (M0) et allocation défensive (H-CS1)

Statut : MESURÉ — H-CS1 NON SOUTENU (M0 consignée)

## 1. Contexte et question

Après la fermeture des axes sizing, exits et permission
(`confidence-sizing-walkforward.md`, `regime-exit-v3.md`,
`strategy-permission.md` §11), le champion reste V1-IDENTITY : ~+1,7 %/an
cumulé sur dix fenêtres annuelles, drawdowns ≤ 6,9 %. Le diagnostic
`bull-alpha-diagnosis.md` §3 établit l'écart structurel vs buy-and-hold
(~118 pt en bull) comme la nature d'un bot à signaux sous-exposé.

Question H-CS1 : **un mix passif w·holding + (1−w)·bot domine-t-il le
holding pur en risque ajusté** — c'est-à-dire : la seule valeur mesurée du
bot (contrôle du drawdown) survit-elle à la composition avec l'actif
sous-jacent qu'il trade ?

Ce document est un **diagnostic mesuré**, pas un modèle de comportement :
aucun changement déployé, aucune sélection automatique de w. Il produit la
baseline holding manquante (M0) puis l'analyse de mix (H-CS1). Tout
déploiement éventuel d'un mix exigera son propre cycle Model → Review →
Implement → Verify.

## 2. Données

BTC-USD ONE_DAY, les 10 fenêtres annuelles D2-S (`[YYYY-08-21 →
YYYY+1-08-21]` UTC), config V1 bit-identique (gate EMA_THRESHOLD 100/5/3,
exits REGIME_CONDITIONAL bull NONE / autres FIXED 300/600, calibration
IDENTITY, permission défaut, frais 6 bps, slippage 2 bps, capital 10 000,
targetSignalNotional 1 000, risque V1).

## 3. M0 — baseline holding par fenêtre

Mécanique **identique à `benchmarkBuyAndHold`** (`packages/backtest/src/suite.ts`
L200-238, source unique des constantes) : achat au **premier open** de la
fenêtre au prix `open × (1 + slippageBps/10 000)` avec frais `feeBps` sur le
notional, quantité `capital / (prix × (1 + feeRate))`, marque au **dernier
close**. Rendement par fenêtre = équité finale / 10 000 − 1.
`benchmarkBuyAndHold` ne retourne qu'un résumé (`{pnl, totalReturn,
finalEquity}`, suite.ts L67-71) — ni courbe ni drawdown. Le script construit
la courbe holding bougie par bougie avec la même mécanique d'achat (même
formule de prix d'exécution, de quantité et de frais), puis appelle
`calculateMetrics` sur cette courbe pour obtenir le dd M0 et alimenter la
jambe holding du mix.

Livrable M0 : table `holding return / holding dd` par fenêtre (dd calculé
sur la courbe journalière : pic → creux, comme `calculateMetrics`). Les
points épars documentés (bull 2023→24 +125 % ; bear 2025→26 −24 %) servent
de contrôle d'ordre de grandeur, pas de contrôle bit-exact (aucune baseline
holding publiée n'existe sur ces bornes exactes).

## 4. H-CS1 — courbes de mix sans rééquilibrage

- **Jambe bot** : UN replay V1-IDENTITY par fenêtre, capital 10 000
  (sémantique V1 bit-exacte, limites de risque absolues inchangées).
  Courbe d'équité exposée par `BacktestResult.equityCurve` : exactement un
  point par bougie, `at = candle.start`, marqué au close.
- **Jambe holding** : achat M0 au premier open, marquée au close de chaque
  bougie (même index `candle.start`).
- **Mix** : `mixEquity(t) = w · holdEquity(t) + (1−w) · botEquity(t)` en
  dollars — each jambe démarre avec sa part (w·10 000 / (1−w)·10 000),
  **aucun rééquilibrage intra-fenêtre**, fenêtres indépendantes (reboot
  annuel à 10 000, miroir des campagnes existantes). La mise à l'échelle
  linéaire de la jambe bot est exacte parce que le mix détient une part
  passive d'une stratégie déjà déroulée : aucun chemin de décision ne
  dépend de w. L'alignement des courbes couvre toutes les bougies de la
  fenêtre, **y compris le warmup** (le bot y est flat ; la holding est
  investie dès la première bougie).
- **Grille a priori** : w ∈ {0,25 ; 0,50 ; 0,75} (part holding). w = 1 et
  w = 0 calculés comme contrôles d'extrémité (≡ holding, ≡ bot).
- Métriques par courbe via `calculateMetrics(curve, [], 10_000, 0)` :
  seuls `totalReturn`, `maxDrawdown` et `sharpe` (définis sur la courbe)
  sont lus ; les champs par trades sont sans objet (liste vide).

## 5. Invariants

| # | Invariant |
| --- | --- |
| INV-CS1 | Le replay bot de chaque fenêtre est la config V1 bit-identique ; contrôle de non-dérive : 2023 reproduit +0,27 % / dd 2,93 % et 2025 +3,63 % / 3,37 % (tolérance 5e-5, miroir WF3-P). |
| INV-CS2 | Alignement : les trois courbes (bot, holding, mix) partagent le même index `candle.start` bougie par bougie ; toute longueur divergente invalide la fenêtre. |
| INV-CS3 | Extrémités : mix(w=1) ≡ courbe holding et mix(w=0) ≡ courbe bot à l'epsilon flottant près (contrôle de câblage de la formule). |
| INV-CS4 | Aucune fenêtre n'est retirée après observation ; une fenêtre indisponible (`HISTORICAL_*`) est éliminée et consignée, jamais comblée. |
| INV-CS5 | w n'entre nulle part dans le replay ; il n'existe que dans la formule de mix du script de diagnostic. |

## 6. Critères a priori

Notations par w : `G(w)` = rendement géométrique annuel moyen sur les
fenêtres (`∏(1+rᵢ)^(1/N) − 1`) ; `DDworst(w)` = drawdown annuel maximal ;
`DDmed(w)` = drawdown médian ; Sharpe consigné sans être critère.

- **W-CS-A (Calmar)** : `G(w)/DDworst(w) > G(1)/DDworst(1)`.
- **W-CS-B (réduction dd)** : `DDworst(w) ≤ 0,8 × DDworst(1)` (≥ 20 % de
  réduction du pire drawdown annuel).
- **W-CS-C (plancher rendement)** : `G(w) ≥ 0,5 × G(1)` (au moins la
  moitié du rendement géométrique du holding).

**VALIDÉ** s'il existe w ∈ {0,25 ; 0,5 ; 0,75} passant A ∧ B ∧ C ∧ INV-CS1
à CS5 ; w* = argmax Calmar parmi les admissibles, égalité → plus petit w.
Sinon **NON SOUTENU** : la valeur défensive du bot ne survit pas à la
composition — la voie core-satellite est fermée comme proposition mesurable
et le bot reste ce qu'il est (stratégie autonome à edge non démontré).

## 7. Limites assumées

- **Sous-exposition structurelle du bot** : V1-IDENTITY a une médiane de
  notional approuvé = $0 et ~50 trades/an sur 365 bougies
  (`bull-alpha-diagnosis.md` §3). Pour w ≥ 0,50, la jambe bot du mix est
  majoritairement du cash, ce qui polarise le résultat : réduction de dd
  quasi automatique (W-CS-B facilement satisfaite), plancher de rendement
  quasi impossible (W-CS-C difficilement franchissable). Le protocole le
  détecte — le critère conjoint A ∧ B ∧ C reste falsifiable — mais le
  résultat probable est NON SOUTENU par impossibilité de satisfaire C
  simultanément avec B pour w élevé, et par domination triviale du holding
  pour w faible.
- **Contamination** : les rendements bot par fenêtre sont déjà connus
  (grilles D2-S/D3-P2). La grille w est fixée a priori et w n'est pas un
  paramètre déployé ; la mesure reste un diagnostic. Un déploiement exigerait
  réplication sur produits OOS propres (cf. `signal-edge-inventory.md` H-D1).
- Le holding achète au premier open de chaque fenêtre annuelle ; le mix
  « reboot » donc chaque 21 août. Un mix continu pluriannuel sans reboot
  serait un modèle séparé (rééquilibrage, fiscalité) — hors périmètre.
- Sharpe journalier sur fenêtres annuelles : indicatif (N=365 par fenêtre,
  agrégation par fenêtre indépendante).
- Frais de rebalancement : nuls par construction (aucun rééquilibrage) ;
  les frais d'entrée holding et les coûts bot sont inclus dans chaque jambe.

## 8. Livrables

- `packages/backtest/scripts/core-satellite-mix.ts` : une exécution, sortie
  tabulaire (M0 puis grille w), contrôle INV-CS1/CS3 affiché.
- Ce document complété : §9 résultats, statut → MESURÉ.

## 9. Résultats

Exécution : `packages/backtest/scripts/core-satellite-mix.ts`, 10/10 fenêtres
chargées (2016 incluse). **INV-CS1 PASS** (2023 et 2025 reproduits bit-près),
INV-CS2/CS3 PASS (contrôles exécutés à chaque fenêtre), INV-CS4 sans objet
(aucune fenêtre indisponible).

### 9.1 M0 — baseline holding par fenêtre (ret / dd)

| Fenêtre | Holding | Bot V1 | w=0,25 | w=0,50 | w=0,75 |
| --- | --- | --- | --- | --- | --- |
| 2016 | +595,82 % / 36,25 % | +2,35 % / 1,50 % | +150,72 % / 23,10 % | +299,09 % / 30,41 % | +447,46 % / 34,06 % |
| 2017 | +54,38 % / 70,22 % | +3,85 % / 6,88 % | +16,48 % / 44,01 % | +29,11 % / 58,22 % | +41,74 % / 65,65 % |
| 2018 | +71,93 % / 56,75 % | +3,48 % / 3,48 % | +20,59 % / 16,94 % | +37,70 % / 31,28 % | +54,81 % / 44,51 % |
| 2019 | +10,09 % / 54,93 % | −2,60 % / 3,45 % | +0,58 % / 15,73 % | +3,75 % / 28,80 % | +6,92 % / 41,87 % |
| 2020 | +315,56 % / 53,14 % | +11,33 % / 4,82 % | +87,39 % / 33,98 % | +163,44 % / 44,48 % | +239,50 % / 49,86 % |
| 2021 | −57,20 % / 71,95 % | −5,81 % / 6,21 % | −18,66 % / 26,44 % | −31,50 % / 43,80 % | −44,35 % / 58,79 % |
| 2022 | +23,79 % / 29,65 % | −1,03 % / 1,74 % | +5,17 % / 7,89 % | +11,38 % / 15,35 % | +17,58 % / 22,60 % |
| 2023 | +125,17 % / 26,12 % | +0,27 % / 2,93 % | +31,50 % / 13,97 % | +62,72 % / 19,90 % | +93,94 % / 23,60 % |
| 2024 | +93,48 % / 28,17 % | +2,01 % / 0,59 % | +24,88 % / 10,43 % | +47,74 % / 17,99 % | +70,61 % / 23,70 % |
| 2025 | −36,16 % / 53,08 % | +3,63 % / 3,37 % | −6,32 % / 14,14 % | −16,27 % / 26,94 % | −26,21 % / 39,98 % |

M0 établit la comparaison qui manquait : sur les 10 fenêtres exactes des
campagnes, le holding fait **G = +62,00 %/an géométrique, DDworst 71,95 %,
DDmed 53,11 %** contre G = +1,66 %/an, DDworst 6,88 % pour le bot. L'écart
documenté en bull (~118 pt, `bull-alpha-diagnosis.md`) se généralise : la
décennie mesurée est structurellement haussière pour BTC.

### 9.2 Agrégats et critères

| w | G | DDworst | DDmed | Calmar | A | B | C |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1,00 | +62,00 % | 71,95 % | 53,11 % | 86,17 | — | — | — |
| 0,75 | +52,86 % | 65,65 % | 40,92 % | 80,52 | FAIL | FAIL | PASS |
| 0,50 | +40,41 % | 58,22 % | 29,61 % | 69,41 | FAIL | FAIL | PASS |
| 0,25 | +24,20 % | 44,01 % | 16,34 % | 54,99 | FAIL | PASS | FAIL |
| 0,00 | +1,66 % | 6,88 % | 3,41 % | 24,09 | — | — | — |

**VERDICT : NON SOUTENU** — aucun w ∈ grille ne passe A ∧ B ∧ C.

### 9.3 Lecture

- **La polarisation prédite en review s'est matérialisée exactement** :
  B (réduction dd ≥ 20 %) et C (G ≥ ½ holding) sont mutuellement exclusifs
  sur la grille — w=0,25 satisfait B seul, w≥0,50 satisfont C seuls. La
  cause structurelle est la sous-exposition du bot (jambe ≈ cash) : le mix
  est une interpolation holding ↔ quasi-cash, sans diversification
  véritable (les deux jambes sont le même actif).
- **A (Calmar) échoue partout** : sur cette décennie, le Calmar du holding
  (86) est hors de portée de tout mix — diluer un actif à G = 62 %/an avec
  du quasi-cash réduit le dd moins que proportionnellement au rendement
  perdu. La « valeur défensive » du bot (dd 6,88 %) ne se monnaie pas en
  risque ajusté : elle est écrasée par la magnitude du rendement holding.
- Observation consignée hors critères : w=0,25 offre G = +24,2 %/an avec
  DDworst 44 % (contre 72 % en holding pur) — pertinente uniquement sous
  une contrainte de dd max < 50 % qui n'est pas celle du protocole ; elle
  n'est pas un verdict et n'autorise aucun déploiement.
- Limite temporelle assumée : le verdict est lié à l'échantillon (décennie
  bull extrême). Sur un régime futur plat/baissier prolongé, le classement
  Calmar pourrait différer — mais le protocole a priori ne se réexécute pas
  sur fenêtres glissantes post-hoc (§7 contamination).

**Conséquence (§6)** : la voie core-satellite est **fermée comme
proposition mesurable**. Le bot reste une stratégie autonome à edge non
démontré ; sa seule valeur mesurée (contrôle du drawdown) ne survit pas à
la composition avec l'actif sous-jacent en risque ajusté. La priorité
resterait à la branche 4 (signaux/data, `signal-edge-inventory.md`) et au
verdict H-P2 (`regime-aware-selector.md`).

## 10. Hors périmètre

- Rééquilibrage intra-fenêtre, mixes multi-actifs, autres produits (H-D1).
- Tout changement de config V1 (un seul objet mesuré : la composition).
- Interprétation du Sharpe comme critère de décision.
