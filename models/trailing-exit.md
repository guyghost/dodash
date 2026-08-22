# Exit protectif — trailing stop (TRAILING_BPS)

Statut : PROPOSÉ
Date : 2025-12-17
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

- `takeProfitPrice: number | null` (null en TRAILING_BPS, inchangé sinon).
- `anchorPrice: number` — max des plus hauts observés, initialisé au prix
  moyen d'entrée à l'armement/replan.

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
| TE1 | Stop monotone non-décroissant sur la vie du plan ; ne monte qu'après évaluation complète d'une bougie |
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

## 5. Hors périmètre

- Trailing par régime, trailing en bras REGIME_CONDITIONAL.
- Trailing sur short (positions longues uniquement, comme tout le
  backtest actuel).
- Take-profit combiné au trail (v2 potentielle si la v1 valide).
