# Exits par régime v3 — bras hétérogènes (bull TRAILING, bear FIXED)

Statut : PROPOSÉ
Date : 2025-12-17
Prérequis : `regime-exit.md` (V1 déployée : bull NONE +0,27 % | bear
FIXED 600/600 +3,63 %), `trailing-exit.md` (trail 500 pur : bull
+2,61 % | bear −0,99 %), `trailing-take-profit.md` (v2 : co-armer trail
et take sur un même plan est destructoire dans les deux sens)

## 1. Problème

Trois cycles de mesures isolent deux mécanismes qui dominent chacun sa
fenêtre :

- **bull** : le trailing verrouille les rebonds (+0,27 % → +2,61 %,
  monotone au trail, sans plafond — tout take tronque la queue) ;
- **bear** : le fixe 600/600 récolte les rallyes bornés (+3,63 %).

La v2 a établi que la combinaison **sur un même plan** (champ take du
mode TRAILING) se neutralise : le ratchet convertit les sorties TP en
stops prématurés, et le TP plafonne la queue bull. La seule synthèse
restante est **structurelle** : séparer les mécanismes par bras de
régime, là où le gate assigne déjà chaque fenêtre à son bras.

## 2. Changement du modèle

### 2.1 Types

`RegimeExitArm` gagne la variante trailing (sans take — v2 l'a invalidé
sur la fenêtre où ce bras sera actif) :

```ts
type RegimeExitArm =
  | { readonly mode: "NONE" }
  | { readonly mode: "FIXED_BPS"; readonly stopLossBps: number; readonly takeProfitBps: number }
  | { readonly mode: "TRAILING_BPS"; readonly trailBps: number };
```

Cible v3 : bullish `TRAILING_BPS` 500, bearish/range/warmUp
`FIXED_BPS` 600/600 (structure V1, seul le bras bull change).

### 2.2 Résolution et replan

`resolveRegimeExitArm` retourne déjà tout bras non-NONE comme politique
active : un bras TRAILING devient `ActiveProtectiveExitPolicy` (la
variante du bras, sans take, est structurellement assignable au mode —
`takeProfitBps` y est optionnel) et traverse le replan existant
inchangé (comparaison d'égalité → cancel → re-arm). Aucun changement
de signature. `replay.ts` : **zéro changement**. La machine protective :
**zéro changement** (elle consomme une politique TRAILING depuis v1
trailing — ratchet inclus via `advanceTrailingPlan`).

### 2.3 Validation

`isValidRegimeExitArm` étend sa branche TRAILING en **déléguant** à
`isValidProtectiveExitPolicy` sur la politique active équivalente —
bornes à source unique, pas de duplication des constantes.

### 2.4 CLI

`--protective-exit REGIME_CONDITIONAL --stop-loss-bps 600
--take-profit-bps 600 [--bull-trail-bps N]`.

- Sans `--bull-trail-bps` : bras bullish NONE — **bit-identité V1**
  (run id et métriques).
- Avec : bras bullish `TRAILING_BPS { trailBps: N }`.
- `--bull-trail-bps` hors REGIME_CONDITIONAL → rejet.
- Manifeste : segment `regime-exit` gagne `bulltrail:{n}` seulement si
  le flag est présent. Suffixe : `-regime-exit-600-600` inchangé sans
  flag, `-regime-exit-600-600-bt-{n}` avec.

## 3. Invariants

| # | Invariant |
|---|-----------|
| RC1 | `--bull-trail-bps` absent → politique, run id et métriques bit-identiques à V1 |
| RC2 | Bras TRAILING valide : `trailBps ∈ ]0, 10 000[` (`INVALID_PROTECTIVE_POLICY` sinon, bornes partagées avec le mode) |
| RC3 | Un plan issu d'un bras TRAILING obéit à tous les invariants TE du mode (ratchet post-évaluation, sortie au niveau figé, anchor au re-arm) |
| RC4 | Changement de régime → replan au bras résolu uniquement si les politiques diffèrent (`activeProtectivePolicyEquals` couvre TRAILING depuis v2) ; même comportement armé→armé que armé→NONE |
| RC5 | Tout re-arm (changement de régime ou position augmentée) repart de l'entrée courante : anchor réinitialisé (comportement TE6, déjà en place) |
| RC6 | CLI : `--bull-trail-bps` accepté seulement en REGIME_CONDITIONAL **où le bras armé fixe (stop+take) reste requis** — le flag seul est insuffisant ; manifeste/suffixe étendus seulement si présent |
| RC7 | Zéro nouvelle transition machine, zéro changement replay.ts ; les bras restent des données pures résolues par fonction pure ; aucun LLM |

## 4. Plan de mesure

Fenêtres bull/bear usuelles, gate EMA_THRESHOLD 100/5/3 inchangé.
Grille : `bullTrailBps ∈ {500, 700}` (700 sonde la monotonie au-delà de
l'optimum mesuré) × fenêtres. Contrôles : V1 et T3 déjà consignés (RC1
couvre la bit-identité par tests).

### Critères de succès a priori

- Bull : return ≥ +3 % **et** dd ≤ 10 %
- Bear : return > 0 % **et** dd ≤ 10 %
- Les deux fenêtres, même cellule.

### Attendu et risques

- Attendu nominal : bull ≈ T3 (+2,61 % — **juste sous la barre** a
  priori +3 %), bear ≈ V1 (+3,63 %). La barre n'est pas ajustée pour
  rester falsifiable ; un verdict d'échec avec bull ≥ +2,5 % et bear
  ≥ +3 % resterait une amélioration nette sur V1 (meilleure composite
  mesurée) et motivera une décision explicite sur la barre.
- Risque d'interaction : dans la fenêtre bull, les brefs flips BEARISH
  armeront FIXED 600/600 (V1 les désarmait via bras bull NONE —
  symétriquement, les flips BULLISH de la fenêtre bear armeront
  TRAILING au lieu de désarmer). L'attribution n'est donc pas une
  variation à variable unique au niveau trade ; les compteurs
  stops/takes par fenêtre départageront.
- Risque bear : les flips BULLISH en fenêtre bear substituent un stop
  ratcheté au fixe 600 pendant les rallyes ; si le ratchet rend plus
  qu'il ne protège, bear dégradera sous V1 — la grille 500 vs 700
  quantifiera la sensibilité.

## 5. Hors périmètre

- Take-profit sur le bras TRAILING (invalidé par v2).
- Bras TRAILING différenciés par trailBps (bull vs range) — un seul
  paramètre à la fois.
- Trailing sur short.
