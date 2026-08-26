# H-S1a — Découplage des EMAs de signal du filtre de régime

Statut : MESURÉ — DÉCLASSÉ (H-S0 retenue ; branche 4 épuisée, K3 : arrêt
de la recherche d'edge V1 ; infrastructure conservée, INV-E1 bit-exacte)

## 1. Contexte et question

`signal-edge-inventory.md` §3.2 établit le verrou mécanistique : ema-cross
émet uniquement à la bougie de transition de ses EMAs — qui sont les
**mêmes 12/26** que le filtre de régime. Au moment du cross, l'écart est
quasi nul ; BULLISH (seul régime où ema-cross est autorisé) exige un écart
> 100 bps confirmé 3 fois après 5 observations — atteint ~8+ bougies après
le cross, quand la stratégie n'émet plus rien. Résultat mesuré : 0,00 % sur
6 fenêtres, jamais un signal exécutable (`weak-year-diagnosis.md` §6.4 M5).

Après H-D1 (`product-oos-replication.md` : DÉCLASSÉ, K1 déclenché), ce
verrou est le **dernier levier** désigné sur la source du signal.

**Hypothèse falsifiable H-S1a** : donner à ema-cross une paire d'EMAs de
signal **plus rapide** que la paire du filtre (5/13 vs 12/26) rend la
stratégie non inerte — des crosses surviennent *à l'intérieur* de régimes
BULLISH confirmés et passent le gate — et cet apport améliore l'ensemble
V1 en walk-forward sans violer les portes de sécurité.

**Contre-hypothèse H-S0** : soit l'inertie persiste mécaniquement (solo
ema 5/13 : zéro fill partout), soit l'apport ne transfère pas OOS (W1/W2
fail), soit la sécurité casse (W3 fail) → le levier est fermé, la branche 4
est épuisée sur ce candidat et la recherche d'edge V1 s'arrête (K3).

## 2. Faits établis utilisés (code et mesures antérieures)

- `packages/strategies/src/ema-cross.ts` L26-35 : émission à la transition
  uniquement (`crossedUp`/`crossedDown`), HOLD sinon ; confidence =
  |fast − slow| / slow ; warm-up `previous === null` → HOLD.
- `packages/indicators-prolog/src/engine.ts` L28-31 :
  `DEFAULT_INDICATOR_CONFIG` — une seule paire `emaFastPeriod 12 /
  emaSlowPeriod 26`, consommée à la fois par ema-cross et par le filtre
  (`CANDLE_CLOSED { emaFast, emaSlow }`).
- `models/regime-filter.ts` L10-14 : ema-cross autorisé uniquement en
  BULLISH ; `EMA_THRESHOLD 100/5/3` (V1).
- `weak-year-diagnosis.md` §6.4 : solo ema-cross = 0,00 % sur les 6 fenêtres
  mesurées (2016-2024) — inertie, jamais d'anti-edge observé (aucune perte
  à attribuer).

## 3. Modèle — paire de signal optionnelle dans le moteur

`IndicatorConfig` gagne deux champs optionnels
`signalEmaFastPeriod` / `signalEmaSlowPeriod` ; le snapshot gagne
`signalEmaFast` / `signalEmaSlow` (0 tant que non calculées ou non
configurées, convention maison de l'échauffement). `createEmaCrossStrategy`
lit la paire de signal **si elle est active** (les deux > 0), sinon la paire
historique `emaFast/emaSlow` — comportement actuel à l'identique.

- Le calcul passe par le même résolveur Prolog `ema/3` sur les closes —
  aucun indicateur hors `indicators-prolog` (frontière maison conservée).
- La confidence de la stratégie se calcule sur la paire **utilisée**.
- Le filtre de régime, l'allocation, le risque, les exits et les
  permissions ne changent pas : ils consomment toujours `emaFast/emaSlow`
  (12/26).

**Propriété de bascule pour E1 (5/13)** : `requiredIndicatorCandles` V1 =
26 (porté par `emaSlowPeriod`). La paire de signal 5/13 nécessite
seulement 13 candles. Au premier candle évalué (index 26),
`signalEmaFast` et `signalEmaSlow` sont donc déjà > 0 ;
`previousIndicators === null` garantit HOLD (INV-E6). Au candle suivant,
la paire 5/13 est active et reste active pour tout le reste de la fenêtre —
**il n'y a pas de transition silencieuse d'une paire à l'autre en cours de
replay**. Cette propriété dépend de `signalEmaSlowPeriod ≤ emaSlowPeriod`
(garantie par INV-E2 via `requiredIndicatorCandles`).

### Invariants

| # | Invariant |
| --- | --- |
| INV-E1 | Champs absents de la config ⇒ **zéro requête Prolog additionnelle**, snapshots inchangés, replay **bit-identique** à V1 (test unitaire + contrôle de campagne WF3-E). |
| INV-E2 | Validation fail-closed : les deux périodes présentes ou aucune ; entiers, `1 ≤ fast < slow` ; toute autre combinaison est rejetée (`INDICATOR_CONFIG` invalide), jamais corrigée silencieusement. `requiredIndicatorCandles` inclut `signalEmaSlowPeriod` quand il est présent, afin que le warm-up du moteur couvre le calcul complet de la paire de signal. |
| INV-E3 | Paire active ⇒ ema-cross utilise **exclusivement** la paire de signal (détection de cross et confidence) ; jamais de mélange des deux paires dans une décision. |
| INV-E4 | Le filtre de régime consomme toujours `emaFast/emaSlow` (12/26) — le candidat ne touche ni la classification ni les permissions (rgime BULLISH reste la seule porte d'ema-cross). |
| INV-E5 | Indicateurs purs et déterministes via Tau-Prolog ; stratégies pures ; aucun LLM, aucun effet réseau. |
| INV-E6 | Échauffement (`signalEma` à 0 ou `previous === null`) ⇒ HOLD, identique au comportement actuel. |

## 4. Choix a priori de 5/13 (pré-enregistré, sans balayage)

- **Pré-enregistrement** : `signal-edge-inventory.md` §4 (H-S1a) fixe déjà
  « ex. 5/13 vs 12/26 » dans un document approuvé en review avant toute
  mesure de ce candidat.
- **Argument structurel** : pour qu'un cross survienne à l'intérieur d'un
  régime BULLISH confirmé (écart 12/26 > 100 bps soutenu), la paire de
  signal doit être strictement plus rapide que la paire du filtre ; 5 et 13
  sont tous deux inférieurs à 12/26 respectivement.
- **Standard de pratique** : 5/13 (nombres de Fibonacci) est une paire
  rapide usuelle, sans lien de tuning avec aucune donnée observée du dépôt —
  ema-cross n'a jamais produit un seul trade, il n'existe rien sur quoi
  accorder ce choix.
- **Un seul degré de liberté** : la paire de signal d'ema-cross. Tout autre
  changement de V1 est interdit ce cycle ; tout balayage de périodes
  (3/10, 6/13, 8/21…) est exclu a priori — une variante serait une
  nouvelle hypothèse pré-enregistrée.

## 5. Espace de candidats

| Candidat | Config | Lecture |
| --- | --- | --- |
| E0 (défaut) | champs absents | baseline V1 bit-exacte (INV-E1) |
| E1 | `signalEmaFastPeriod 5 / signalEmaSlowPeriod 13` | découplage : crosses 5/13 possibles en BULLISH confirmé |

## 6. Protocole de vérification

- 10 fenêtres annuelles BTC-USD (2016..2025, bornes `[YYYY-08-21 →
  YYYY+1-08-21]` UTC) × {E0, E1}, config V1-IDENTITY bit-identique
  D3-P2 par ailleurs. 20 replays d'ensemble.
- **Portes d'éligibilité par train** (miroir D3-P2 §10, sans borne
  médiane — leçon du post-mortem D3-P) : dd ≤ 10 %, turnover ≤ 10,
  feeRate ≤ 1 %, `signalsPassed > 0` ; puis argmax return train ;
  défaut E0.
- 9 folds origine glissante ; **folds propres** = ni train ni test ∈
  {2023, 2025} — 6 attendus, ≥ 4 requis.
- **WF3-E (non-dérive)** : E0 reproduit les baselines V1 (2023 +0,27 % /
  dd 2,93 % ; 2025 +3,63 % / 3,37 %, tol 5e-5).
- **Contrôle d'effet** :
  1. *inertie brisée* — un replay **solo** ema-cross sous E1 produit
     ≥ 1 fill clôturé sur au moins une fenêtre (sous E0, solo = 0,00 %
     connu, M5). Un solo E1 à zéro trade partout invalide la campagne :
     le verrou n'est pas levé mécaniquement ;
  2. *la policy mord* — en ensemble, `signalsPassed` et/ou
     `deniedByStrategy["ema-cross"]` diffèrent entre E0 et E1 sur les
     fenêtres ;
  3. *confinement structurel* — les permissions garantissent par
     construction qu'aucune décision ema-cross ne passe hors BULLISH
     (INV-E4) : contrôle couvert par la structure, pas re-mesuré.
- **Mesures secondaires consignées** (hors critères) : solo E1 par fenêtre,
  effectif de trades ema en ensemble (via Δtrades E1−E0), turnover.

## 7. Critères a priori (folds propres uniquement)

- **W1-E (stabilité)** : E1 sélectionné sur ≥ 4/6 trains propres.
- **W2-E (transfert OOS)** : le sélectionné bat E0 en return test sur
  ≥ 4/6 folds propres ET spread médian (sélectionné − E0) > 0. Un fold où
  E0 est sélectionné produit un spread nul — il ne compte pas comme « bat ».
- **W3-E (sécurité)** : dd test ≤ 10 % sur folds propres pour le
  sélectionné.
- **VALIDÉ** = W1-E ∧ W2-E ∧ W3-E ∧ WF3-E ∧ contrôle d'effet. Tout autre
  issue = **DÉCLASSÉ** → H-S0 retenue : le levier découplage est fermé, la
  branche 4 n'a plus de candidat pré-enregistré, K3 s'applique (arrêt de la
  recherche d'edge V1, constat final de rentabilité négatif).

## 8. Verrou épistémique

Un verdict VALIDÉ **ne déploie rien** (pas de flag CLI live, pas de porte
`production-launch.md` ouverte). Unique suite autorisée : **H-D2** —
réplication du couple (V1 + E1) sur des produits **jamais consultés et non
brûlés par H-D1** (pool éligible restant de la découverte H-D1 : 43 − 4 =
39 produits, allowlist append-only `signal-edge-inventory.md` §5.1 +
`product-oos-replication.md` §8.1), miroir strict du protocole H-D1.
Les fenêtres BTC restent in-sample pour ce candidat ; seule H-D2 produit
de l'OOS. Aucun ajustement de 5/13 après lecture des résultats.

## 9. Livrables

- `packages/indicators-prolog/src/engine.ts` : champs optionnels + calcul
  Prolog `ema/3` (INV-E1/E2/E5/E6) ; `requiredIndicatorCandles` (L203-215)
  ajoute `config.signalEmaSlowPeriod` au `Math.max` quand il est défini,
  afin que le warm-up couvre la paire de signal.
- `packages/strategies/src/ema-cross.ts` : lecture de la paire de signal
  active (INV-E3).
- `packages/backtest/src/replay.ts` : `validPreparedIndicators` (L202-229)
  doit comparer `signalEmaFastPeriod` et `signalEmaSlowPeriod` entre la
  config préparée et la config du replay. Sans cette comparaison, WF3-E
  peut passer avec un mismatch silencieux (INV-E1 violé sans détection).
- Tests unitaires : INV-E1 (bit-exactitude sans champs), INV-E2 (rejets),
  INV-E3 (cross détecté sur la paire signal dans un BULLISH établi —
  candles synthétiques), INV-E6 (warm-up HOLD).
- `packages/backtest/scripts/ema-decoupling-walkforward.ts` : campagne §6.
- Ce document complété : §10 résultats, statut → MESURÉ.

## 10. Résultats

Exécution : `packages/backtest/scripts/ema-decoupling-walkforward.ts`
(2026-08-26), 10/10 fenêtres, 20 replays d'ensemble + 20 solos.
**WF3-E PASS** (2023 et 2025 reproduits bit-près) : les changements du
cœur pur sont non dérivants — E0 reste V1 à l'identique.

### 10.1 Contrôles d'effet

- **Effet 1 (inertie brisée) : PASS.** Solo E0 : 0 fill sur 10/10 fenêtres
  (inertie V1 confirmée). Solo E1 : 3-9 fills sur 7/10 fenêtres (0 en
  2021/2024/2025, années à faible contenu BULLISH-confirmé). **Le verrou
  mécanistique §1 était réel et le découplage le lève** — le diagnostic de
  `signal-edge-inventory.md` §3.2 est validé expérimentalement.
- **Effet 2 (la policy mord en ensemble) : FAIL — post-mortem du
  contrôle, verdict sans objet.** `signalsPassed` et `deniedEma` sont
  identiques E0/E1 sur les 10 fenêtres (ex. 2016 : 584→584, 87→87). Cause
  établie : ces compteurs dénombrent le gating **par bougie** (le signal
  ema est évalué chaque jour, HOLD compris) — ils dépendent du régime
  12/26, pas de la paire émettrice. Le contrôle était mal spécifié :
  insensible au candidat. La morsure réelle est visible côté **trades** :
  11→14 (2016), 37→41 (2017), 15→21 (2020), 9→14 (2023) — E1 ajoute des
  décisions exécutables en ensemble. Le verdict ne repose pas sur ce
  contrôle (W1-E/W2-E échouent indépendamment, cf. ci-dessous).

### 10.2 Solo E1 par fenêtre (ret / fills clôturés)

| Fenêtre | ret | fills/clôturés | | Fenêtre | ret | fills/clôturés |
| --- | --- | --- | --- | --- | --- | --- |
| 2016 | −0,01 % | 4/2 | | 2021 | 0,00 % | 0/0 |
| 2017 | +0,10 % | 3/2 | | 2022 | −0,01 % | 3/2 |
| 2018 | +0,04 % | 5/2 | | 2023 | −0,01 % | 6/4 |
| 2019 | −0,00 % | 3/2 | | 2024 | 0,00 % | 0/0 |
| 2020 | +0,11 % | 9/5 | | 2025 | 0,00 % | 0/0 |

Le signal réveillé est **économiquement vide** : −0,01 % à +0,11 % par an.

### 10.3 Ensemble et critères (folds propres : 6)

- E1 sélectionné sur 2/6 trains propres (2018, 2021 — trains faibles où le
  petit apport solo pèse) : **W1-E FAIL** (≥ 4 requis).
- Sélectionné bat E0 sur **0/6** tests propres, spread médian **0,00 %** :
  **W2-E FAIL**.
- **W3-E PASS** (0 violation dd — E1 ne dégrade jamais la sécurité).
- Ensemble : les deltas E1−E0 vont de −0,26 pp (2017) à −0,00 : E1 est
  neutre à légèrement négatif, jamais améliorant.

**VERDICT : DÉCLASSÉ** — W1-E F · W2-E F · W3-E P · WF3-E P · effet 2 F
(mal spécifié, sans objet). **H-S0 retenue.**

### 10.4 Lecture et conséquences

- **Le diagnostic mécanistique était correct, l'hypothèse économique
  était fausse** : le découplage libère bien des crosses 5/13 en BULLISH
  confirmé, mais ces crosses ne portent pas d'edge mesurable (solo ≈ 0).
  Le problème d'ema-cross n'était pas seulement le verrou — le signal de
  cross lui-même est sans valeur sur BTC daily aux coûts 6+2 bps.
- **K3 acté** : la branche 4 n'a plus de candidat pré-enregistré. La
  recherche d'edge pour V1 s'arrête sur une chaîne d'évidence complète :
  H-P2 (sélection) fermée, H-CS1 (mix défensif) fermée, H-D1 (transfert
  OOS) négative sur 4 produits propres, H-S1a (réparation du signal mort)
  économiquement vide. La réponse à « V1 peut-il être rentable en
  trading ? » est **non**, établie par protocoles pré-enregistrés.
- **Infrastructure conservée** : les champs optionnels
  `signalEma{Fast,Slow}Period` (INV-E1 bit-exact, INV-E2 fail-closed,
  INV-E3 exclusif, `validPreparedIndicators` à jour, tests au vert)
  demeurent une capacité testée et inerte par défaut — réutilisable pour
  tout futur cycle de signal sans retoucher le moteur.
- Le contrôle d'effet 2 mal spécifié est consigné tel quel (règle a
  priori exécutée honnêtement) ; tout futur protocole qui veut mesurer la
  morsure d'un candidat doit cibler les **décisions exécutables** (trades,
  fills), pas les compteurs de gating par bougie.

## 11. Limites assumées

- **Interaction SELL ↔ positions rsi** : un cross-down 5/13 en BULLISH
  émet un SELL qui peut clôturer une position ouverte par rsi-reversion
  (ou être rejeté `SPOT_SHORT_FORBIDDEN` sans position). L'interaction
  n'est pas décomposée ; elle est mesurée par le walk-forward d'ensemble —
  c'est l'objet du test.
- **Turnover et frais** : E1 ajoute mécaniquement des décisions ; les
  portes turnover ≤ 10 et feeRate ≤ 1 % bornent, et W2-E juge net de coûts.
- **Confidence redéfinie** : sous E1, la confidence ema est mesurée sur
  la paire 5/13 — la calibration de confiance (IDENTITY en V1) n'est pas
  re-testée (axe fermé) ; consigné pour mémoire.
- **In-sample BTC** : l'évaluation reste sur des fenêtres BTC partiellement
  contaminées pour d'autres leviers ; le candidat lui-même n'y a jamais été
  observé. Le verrou §8 (H-D2) porte la charge OOS.
- **Chemin prepared-indicators** : `prepareBacktestIndicators` stocke la
  config dans le résultat ; `replay.ts` la compare champ par champ avant
  utilisation (`validPreparedIndicators`). L'ajout de champs optionnels à
  `IndicatorConfig` exige de mettre à jour cette comparaison — oublier ce
  point casse INV-E1 silencieusement.

## 12. Hors périmètre

- Balayage de périodes ; variantes 3/10, 6/13, 8/21 (nouvelles hypothèses
  à pré-enregistrer si ce cycle échoue — et seulement si une justification
  indépendante émerge).
- Permission par side, timeframes (H-S1c), seuils RSI (H-S1b), produits
  H-D2 dans cette campagne, changement des portes ou de la config V1.
- Mise à jour du schéma Zod de `apps/agent/src/configuration.ts` et de la
  factory snapshot dans `packages/strategies/test/strategies.test.ts`
  (champs additionnels de `IndicatorSnapshot`, défaut 0) — nécessaire à la
  compilation le cas échéant mais hors du chemin critique de cette
  campagne (aucun déploiement live, E1 n'atteint jamais l'agent).
