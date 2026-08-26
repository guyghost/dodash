# H-P2 — sélecteur de permission conditionné au régime du train

Statut : MESURÉ — DÉCLASSÉ (H-P0′ retenue ; axe sélection conditionnée fermé)

## 1. Contexte et statut de l'axe permission

`strategy-permission.md` §11 a mesuré D3-P2 : **DÉCLASSÉ**, H-P0 retenue.
W2 a échoué par **instabilité du choix** (C0 2/6, C2 3/6, C1 1/6), pas par
absence d'effet : quand C2 était sélectionné sur train bearish, le test
transférait (+0,22 à +2,37 pp) ; le fold coûteux est le train bull 2020 qui
sélectionne C0 avant le test bear 2021. La clôture du document stipule :
un sélecteur conscient du régime du train serait une **NOUVELLE hypothèse
(H-P2), à pré-enregistrer avec justification indépendante** — pas une
itération de D3-P2. Ce document est cet enregistrement.

**Hypothèse falsifiable H-P2** : une règle de sélection qui conditionne le
choix du candidat de permission à la composition en régimes du **train**
choisit mieux que l'argmax de rendement train (règle D3-P2), au sens des
critères W2-r/W3-r ci-dessous.

**Contre-hypothèse H-P0′** : la règle ne bat pas l'argmax OOS (spread nul
ou négatif, ou dd cassé) → l'axe sélection conditionnée est fermé à son
tour ; il ne reste que la branche signaux/data.

## 2. Justification indépendante (sources antérieures à D3-P/D3-P2)

La justification ne cite **aucun résultat de grille** D3-P/D3-P2 (§8/§11).
Sources : `weak-year-diagnosis.md` (mécanisme, mesuré avant la conception
des candidats), `strategy-permission.md` §1-§4 (hypothèse et candidats),
le code (`models/regime-filter.ts`, replay). Les contrôles de câblage
D3-P2 (policy mord, zéro décision passée en régime interdit) sont cités
comme preuve de **mécanisme**, pas de performance.

1. **Le mécanisme de perte est localisé et conditionnel** : M5
   (solo/ablation) attribue la quasi-totalité des pertes des années
   faibles à rsi-reversion émettant des BUY en régime BEARISH/RANGE
   prolongé ; M1 montre que ces années sont précisément celles où les
   régimes adverses dominent le calendrier (195-241 j/an).
2. **Les candidats agissent exactement sur ce mécanisme** : C1/C2
   retirent les entrées rsi là où la perte naît (câblage vérifié :
   Δdenied > 0, `passedByRegime` nul en régimes interdits).
3. **L'observable de sélection existe et est gratuit** : la timeline de
   régimes du train est calculable par la méthode `regime-days`
   (rejeu de `regimeFilterMachine` sur les snapshots), sans nouvelle
   donnée ni LLM.
4. **Argument de symmetry/asymétrie** : le bénéfice attendu de C2
   (couper des entrées à espérance négative) ne se matérialise que si la
   fenêtre **d'évaluation** contient une fraction significative de
   régimes adverses ; son coût (renoncer aux entrées rsi) ne se paie que
   si la fenêtre est bull-dominée. Au moment de la sélection, la seule
   information disponible sur « quel régime anime l'époque courante » est
   la composition du train. Une règle qui ne l'utilise pas (argmax
   global) mélange des époques hétérogènes dans un seul scalaire.
5. **Seuil 0,5 = majorité simple**, fixé ex ante : la moitié des jours
   observés en régimes adverses. Aucun balayage de seuil n'est conduit ;
   tout ajustement après observation des résultats invaliderait
   l'enregistrement.

**Ce que la règle ne prétend pas** : prévoir un **flip** de régime. Un
train bull qui précède un test bear (fold 2020→2021) sélectionnera C0 et
subira le test bear — assumé a priori. La règle parie sur la **persistance
interannuelle des époques de régime**, jamais sur leur prévision.

## 3. Règle R-H2 (fonction pure, unique degré de liberté)

Entrées par train : mesures par candidat (portes D3-P2 : dd ≤ 10 %,
turnover ≤ 10, feeRate ≤ 1 %, `signalsPassed > 0` (run actif, miroir exact
du script D3-P2) ; rendement) et fractions de jours par régime du train.

```
F = (jours BEARISH + jours RANGE) / jours observés du train
si C2 éligible (portes D3-P2) et F ≥ 0,5 → sélectionné = C2
sinon                               → sélectionné = C0
```

- C1 **n'est jamais sélectionné** : le distinguer de C2 exigerait un
  second seuil (deux degrés de liberté). C1 reste mesuré et consigné en
  information (continuité de grille avec D3-P2).
- Défaut conservateur C0 dans tous les cas ambigus (C2 non éligible,
  données de régime indisponibles).
- La règle ignore volontairement le rendement train des candidats
  (l'argmax est précisément l'alternative testée) ; les portes de
  sécurité D3-P2 sont conservées telles quelles.

## 4. Protocole (miroir strict de D3-P2)

- 10 fenêtres annuelles (2016..2025, bornes `[YYYY-08-21 →
  YYYY+1-08-21]` UTC) × 3 candidats {C0, C1, C2}, config V1
  bit-identique D3-P2 — seuls `regimePermissions` varie. 30 replays.
- Folds origine glissante (train N → test N+1) ; folds **propres** =
  ni train ni test ∈ {2023, 2025} (contamination `confidence-sizing-walkforward.md`
  §5) — 6 attendus, ≥ 4 requis. Si 2016 est indisponible
  (`HISTORICAL_NETWORK_UNAVAILABLE`, comme en D3-P), 9 fenêtres utiles et
  5 folds propres — le seuil ≥ 4 reste applicable tel quel ; le script
  élimine les folds dont le train ou le test est indisponible (même
  traitement que `regime-permission-walkforward-p2.ts`).
- Sélection par fold : R-H2 (ce document) **et**, pour la comparaison, la
  règle argmax D3-P2 recalculée sur la même grille fraîche.
- **WF3-R (non-dérive)** : C0 reproduit les baselines V1 (2023 +0,27 % /
  dd 2,93 % ; 2025 +3,63 % / 3,37 %, tolérance 5e-5) ET la grille fraîche
  complète correspond à la grille D3-P2 publiée §8 (reproduction
  bit-exact — la mesure dérive de rien, tout écart invalide la campagne).
- **Contrôle de câblage** : la sélection R-H2 de chaque fold est
  recalculée indépendamment depuis les fractions de régimes du train
  (méthode `regime-days`) et doit coïncider ; les compteurs INV-P6
  (`passedByRegime`) restent nuls en régimes interdits pour C1/C2.

## 5. Critères a priori (folds propres uniquement)

- **W1-r (règle exécutable)** : contrôle de câblage PASS sur 100 % des
  folds (la règle est une fonction pure ; toute divergence = FAIL).
- **W2-r (transfert OOS)** : le sélectionné R-H2 bat le sélectionné
  argmax en rendement test sur **≥ 4/6** folds propres ET spread médian
  (R-H2 − argmax) > 0. Un fold où R-H2 et argmax sélectionnent le même
  candidat produit un spread de 0 — il ne compte pas comme « bat »
  (information descriptive : si les deux règles coïncident souvent, R-H2
  est redondante, pas nocive). Information secondaire : spread vs always-C0.
- **W3-r (sécurité)** : dd test ≤ 10 % sur folds propres pour le
  sélectionné R-H2.
- **VALIDÉ** = W1-r ∧ W2-r ∧ W3-r ∧ WF3-R. Tout autre issue = DÉCLASSÉ →
  H-P0′ retenue : l'axe sélection conditionnée est fermé.

## 6. Limite épistémique assumée (verrou explicite)

La grille D3-P2 est **déjà observée** : une évaluation sur les mêmes
fenêtres ne peut pas constituer une confirmation OOS propre, quelle que
soit la discipline de la règle. En conséquence :

- un verdict VALIDÉ **ne déploie rien** et n'ouvre aucune porte
  `production-launch.md` ;
- il n'autorise qu'une seule suite : la **réplication H-D1** (produits
  jamais consultés, quatre folds annuels propres par produit — cf.
  `signal-edge-inventory.md`), où R-H2 sera appliquée sans modification ;
- tout recalibrage du seuil 0,5 ou des portes après lecture des résultats
  est interdit ; une variante serait une nouvelle hypothèse pré-enregistrée.

## 7. Livrables

- `packages/backtest/scripts/regime-aware-selector-walkforward.ts` : miroir
  de `regime-permission-walkforward-p2.ts` (fenêtres, préparation partagée,
  compteurs INV-P6, WF3-R) — seuls changent la règle de sélection R-H2 et
  les critères affichés.
- Ce document complété : §8 résultats, statut → MESURÉ.

## 8. Résultats

Exécution : `packages/backtest/scripts/regime-aware-selector-walkforward.ts`,
10/10 fenêtres chargées, 30 replays. **WF3-R PASS** : baselines V1
reproduites bit-près ET grille D3-P2 §8 intégralement reproduite (9 fenêtres
OK + contrôle 2016 vs D2-S) — la mesure dérive de rien, le verdict porte
sur la règle. **W1-r PASS** (câblage 9/9 folds). **W3-r PASS** (0 violation
dd). 6 folds propres.

### 8.1 Sélections par fold propre

| train | F | R-H2 | argmax | test | R-H2 | argmax | spread |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2016 | 0,25 | C0 | C0 | 2017 | +3,85 % | +3,85 % | 0 |
| 2017 | 0,55 | C2 | C2 | 2018 | +3,70 % | +3,70 % | 0 |
| 2018 | 0,53 | C2 | C1 | 2019 | −0,14 % | −0,23 % | +0,09 pp |
| 2019 | 0,58 | C2 | C2 | 2020 | +11,22 % | +11,22 % | 0 |
| 2020 | 0,36 | C0 | C0 | 2021 | −5,81 % | −5,81 % | 0 |
| 2021 | 0,72 | C2 | C2 | 2022 | −0,05 % | −0,05 % | 0 |

Folds contaminés (info) : 2022→2023 et 2024→2025, spreads nuls sauf
train 2023 (R-H2→C0 +2,01 % vs argmax→C1 +1,53 % en test 2024).

### 8.2 Critères

- **W2-r : FAIL** — R-H2 bat argmax sur **1/6** tests propres (≥ 4
  requis) ; spread médian **0,00 %** (4 folds ont sélectionné = testé le
  même candidat, spread nul par construction, cf. §5). Info secondaire :
  R-H2 bat always-C0 sur 3/6.

**VERDICT : DÉCLASSÉ** — W1-r P · W2-r F · W3-r P · WF3-R P.
**H-P0′ retenue.**

### 8.3 Lecture honnête

- **R-H2 et argmax coïncident sur 7/9 folds** : quand F ≥ 0,5 l'argmax
  préfère déjà C2 (les trains bearish sont précisément ceux où C2 maximise
  le rendement), et quand F < 0,5 les deux retombent sur C0. La règle
  régime-aware n'apporte d'information distincte que sur les trains
  ambigus (F ≈ 0,5 avec classement return inversé) — 2 folds sur l'échantillon,
  dont un seul propre, gagné (+0,09 pp). La règle est **redondante avec
  l'argmax**, pas inférieure : la criticité W2-r (spread médian nul)
  capture exactement cette redondance.
- Le fold coûteux de D3-P2 (train bull 2020 → test bear 2021, −5,81 %)
  n'est pas résolu par R-H2 : F(2020) = 0,36 < 0,5 → C0, identique à
  l'argmax. La règle ne prétendait pas prévoir les flips (§2) et n'en a
  prévu aucun.
- **L'effet C1/C2 sur les années faibles reste réel** (reproduit ici :
  2019 −0,23/−0,14 % vs −2,60 % ; 2021 −1,17/−0,14 % vs −5,81 %) mais
  aucune règle de sélection testée (argmax D3-P2, R-H2) ne le capture en
  procédure walk-forward. L'axe **permission par régime** est fermé sous
  les deux familles de règles ; l'axe **sélection conditionnée** est
  fermé par le présent verdict.

Conséquence : conformément à §6 et à `signal-edge-inventory.md` §6, la
priorité passe à **H-D1** (produits jamais consultés, allowlist fail-closed
§5.1) — sans R-H2 (non déployée), la politique testée y est V1 pure.
H-S1a (découplage EMAs) suit si H-D1 laisse l'edge non démontré.

## 9. Hors périmètre

- Sélection de C1 (second seuil), balayage du seuil F, fenêtres
  intra-annuelles, autres produits (H-D1), changement des portes ou de la
  config V1, ré-optimisation exits/sizing (axes fermés).
