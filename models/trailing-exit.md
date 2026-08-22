# Exit protectif — trailing stop (TRAILING_BPS)

Statut : MESURÉ (verdict négatif, voir §5)
Prérequis : `regime-exit.md` (V1 REGIME_CONDITIONAL), `regime-asymmetry.md`
(constat : les falaises bull et bear se chevauchent — le problème migre du
classifieur vers le mécanisme d'exit)

## 1. Problème

Trois cycles de mesure établissent que le **stop fixe serré** est
irremplaçable pour l'année bear (+3,63 % vs −15,13 %) et destructeur pour
l'année bull (creux stoppés avant rebond : +0,27 % vs +7,42 %). Bras par
régime (V1), bras élargis (V2), re-labeling asymétrique (v3) : aucune
configuration statique ne sépare les deux fenêtres.

**Hypothèse centrale** : un stop *trailing* uniforme (indépendant du
régime) résout la tension par la trajectoire du prix plutôt que par son
étiquette. Le stop ne fait que monter (ratchet) : en tendance bear, il se
comporte comme le stop fixe initial (jamais déclenché en dessous) ; en
creux bull suivi d'un rebond, il verrouille le gain au lieu de subir le
stop d'entrée.

## 2. Changement du modèle

### 2.1 Politique

Nouveau membre de l'union `ProtectiveExitPolicy` :

```ts
{ mode: "TRAILING_BPS"; trailBps: number }   // 0 < trailBps < 10 000
```

- **Uniforme** : pas de bras par régime (l'asymétrie émergente du chemin
  de prix est l'hypothèse testée). Combinable avec `regimeFilter`
  (gating d'entrées inchangé).
- **Sans take-profit** (v1) : les gagnants ne sont coupés que par le
  trail. La vedette V1 (TP 600) coupait les rebonds bull (4–8 takes).

### 2.2 Plan et ratchet

`ProtectiveOrderPlan` évolue :

- `takeProfitPrice: number | null` (null en TRAILING_BPS, non-null et
  inchangé pour FIXED_BPS / REGIME_CONDITIONAL ; toutes les comparaisons
  existantes doivent garder le guard explicite).
- `anchorPrice: number` — max des plus hauts observés, initialisé au prix
  moyen d'entrée à l'armement/replan (chaque replan = nouvelle instance
  de plan, anchor réinitialisé).

Niveau de stop effectif à la bougie *t* (évaluation) :

```text
stop_t = max(prix_moyen × (1 − trailBps/10 000), anchor_{t−1} × (1 − trailBps/10 000))
```

**Ordre par bougie stricte (anti look-ahead)** :
1. `CANDLE_OPENED` : évaluation gap (open ≤ stop_t → sortie GAP_OPEN).
2. `CANDLE_RANGE_REPLAYED` : évaluation intrabar (low ≤ stop_t → sortie
   INTRABAR). Le TP n'existe plus : plus d'ambiguïté stop/TP.
3. **Après** évaluation complète : `anchor_t = max(anchor_{t−1}, high_t)` ;
   le stop ne monte qu'au cycle suivant (jamais ratchet-then-trigger dans
   la même bougie).

### 2.3 Machine XState (`protective-order.machine.ts`)

Aucun nouvel état ni transition structurelle : `idle → armed
{awaitingOpen ⇄ awaitingRange} → triggered | cancelled | failed` reste la
squelette. L'action `completeRange` intègre le ratchet via une fonction
pure `advanceTrailingPlan(plan, policy, candle)` (plan immuable remplacé).
`POSITION_INCREASED` → replan depuis le nouveau prix moyen, **anchor
réinitialisé** (parité RE4 : re-arm depuis l'entrée courante).

### 2.4 CLI

`--protective-exit TRAILING --trail-bps <bps>` (les deux requis).
- Manifeste : `protective:trailing:{trailBps}` ; suffixe : `-trailing-{trailBps}`.
- Pas d'exigence de `--regime-filter` (contrairement à RE7) : le trailing
  est autonome ; le régime reste optionnel pour le gating.

## 3. Invariants

| # | Invariant |
|---|-----------|
| TE1 | Stop monotone non-décroissant **par instance de plan** (un replan POSITION_INCREASED démarre une nouvelle instance, cf. TE6) ; ne monte qu'après évaluation complète d'une bougie |
| TE2 | L'évaluation d'une bougie utilise exclusivement le niveau figé avant cette bougie (pas de ratchet intra-bougie) |
| TE3 | `anchorPrice` = max(prix moyen à l'armement/replan, highs des bougies entièrement évaluées) |
| TE4 | TRAILING_BPS : sorties STOP_LOSS uniquement (GAP_OPEN / INTRABAR) ; aucune sortie TAKE_PROFIT ni AMBIGUOUS |
| TE5 | Modes NONE / FIXED_BPS / REGIME_CONDITIONAL bit-identiques (chemins inchangés, `takeProfitPrice` non-null) |
| TE6 | POSITION_INCREASED → replan depuis le nouveau prix moyen, anchor réinitialisé (parité RE4) |
| TE7 | CLI : TRAILING sans `--trail-bps` rejeté ; `--trail-bps` sans TRAILING rejeté ; trailBps ∈ ]0, 10 000[ |
| TE8 | Validation `isValidProtectiveExitPolicy` étendue ; machine `failed` sur plan invalide (codes existants) |
| TE9 | Aucune décision d'état déléguée à un LLM ; ratchet et déclenchement sont des fonctions pures consommées par la machine |

## 4. Plan de mesure

Fenêtres bull/bear usuelles. Entrées gated par le même `regimeFilter`
EMA_THRESHOLD 100/5/3 que V1 (attribution propre : seul l'exit change).
`TRAILING_BPS` avec trailBps ∈ {150, 300, 500} (3 cellules × 2 fenêtres).

Contrôles : V1 (REGIME_CONDITIONAL 300/600) = D1 v3 ; aucun protectif.

### Critères de succès a priori

- Bull : return ≥ +3 % **et** dd ≤ 10 %
- Bear : return > 0 % **et** dd ≤ 10 %
- Les deux fenêtres simultanément (même cellule).

### Attendus par mécanisme

- Si l'hypothèse path-vs-label est correcte : le bear conserve la
  protection (stop initial = stop fixe) tandis que le bull récupère les
  rebond (exits trailing au-dessus de l'entrée).
- Diagnostic d'échec : si le bear s'effondre, le ratchet est piégé par
  les rallyes bear (sorties en perte après rallye) → piste stop
  hybride (trail + plafond de perte).

## 5. Mesures (2025-12-17)

Grille T1–T3 exécutée (`scripts/trailing-exit-sensitivity.ts`), gating
régime identique V1 (EMA_THRESHOLD 100/5/3), `takes = 0` partout (TE4
vérifié en production). Retours/drawdowns par fenêtre :

| Cell | trail | bull return | bull dd | bear return | bear dd | win bull | win bear |
|------|-------|------------|---------|-------------|---------|----------|----------|
| T1 | 150 | +0,99 % | 0,68 % | +0,65 % | 1,80 % | 31,0 % | 26,2 % |
| T2 | 300 | +1,14 % | 1,78 % | +1,69 % | 3,85 % | 40,0 % | 28,6 % |
| T3 | 500 | +2,61 % | 3,01 % | −0,99 % | 5,59 % | 47,1 % | 40,0 % |

Baselines : V1 (bull +0,27 % | bear +3,63 %), non protégé (+7,42 % |
−15,13 %).

### Verdict : ÉCHEC a priori

Aucune cellule ne satisfait « bull ≥ +3 % ET bear > 0 % ET dd ≤ 10 % »
sur les deux fenêtres. T3 rate les deux barres (bull 2,61 % < 3 %,
bear −0,99 % < 0) ; T1/T2 passent le bear mais pas le bull.

### Lecture mécaniste

- **Le signal path-vs-label est confirmé côté bull** : le return bull
  croît de façon monotone avec le trail (+0,99 → +1,14 → +2,61 %),
  10× la baseline V1 à trail 500, dd contenu (3,01 %).
- **La protection bear se dégrade vers le trail large** (T3 −0,99 %) :
  sans TP, les rallyes bear ne sont plus récoltés (V1 les prenait à
  +6 % via TP 600) et le ratchet rend le stop après rallye. Optimum
  bear intérieur ≈ trail 300 (+1,69 %), mais très en dessous du V1
  (+3,63 %) — le TP fixe portait une partie du gain bear.
- Les optima par fenêtre (bear ≈ 300, bull ≥ 500) sont plus proches
  que pour le stop fixe (falaises 150–200) mais ne coïncident pas.

### Pistes suivantes

1. **Trailing + TP fixe combiné** (v2 du modèle) : conserver le TP à
   600 sur les bras armés pour récolter les rallyes bear, laisser le
   trail gérer les rebonds bull. Extension : `takeProfitBps` optionnel
   sur TRAILING_BPS. C'est la lecture directe de la comparaison
   V1-bear (TP) vs T3-bull (trail).
2. Trail par régime (bras TRAILING en REGIME_CONDITIONAL) : reprendrait
   le jeu d'asymétrie statique déjà invalidé en v3 (falaises
   chevauchantes) — priorité basse.

## 6. Hors périmètre

- Trailing par régime, trailing en bras REGIME_CONDITIONAL.
- Trailing sur short (positions longues uniquement, comme tout le
  backtest actuel).
- Take-profit combiné au trail (v2 potentielle si la v1 valide).
