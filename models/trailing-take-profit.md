# Exit protectif — trailing + take-profit combiné (TRAILING_BPS v2)

Statut : PROPOSÉ
Date : 2025-12-17
Prérequis : `trailing-exit.md` (v1 mesurée : échec a priori, mais bull
monotone au trail et bear privé de TP), `regime-exit.md` (V1 : le bras
bear récoltait les rallyes via TP 600)

## 1. Problème

La v1 trailing isole deux mécanismes complémentaires :

- le **trail** porte le bull (+0,27 % → +2,61 %, monotone au trail) ;
- le **TP fixe** portait le bear de V1 (+3,63 % vs +1,69 % en meilleur
  trailing pur : les rallyes bear étaient récoltés à +6 %).

Les optima par fenêtre ne coïncident pas en trail seul (bear ≈ 300,
bull ≥ 500). L'hypothèse v2 : **combiner les deux sur le même plan** —
le TP coupe les rallyes bear à un plafond connu, le trail verrouille
les rebonds bull au-delà. Deux exits, un seul état.

## 2. Changement du modèle

### 2.1 Politique

`TRAILING_BPS` gagne un champ optionnel :

```ts
{ mode: "TRAILING_BPS"; trailBps: number; takeProfitBps?: number }
```

- Absent → comportement v1 exact (pas de TP, bit-identité aux mesures
  T1–T3).
- Présent → plan armé avec `takeProfitPrice = entrée × (1 + bps/10 000)`.

### 2.2 Plan et évaluation

`takeProfitPrice` déjà nullable (v1) : le TP combiné remplit le champ.
Toute la séquence d'évaluation existante s'applique sans changement :

- `CANDLE_OPENED` : gap stop OU gap TP (ordre stop d'abord, conservateur).
- `CANDLE_RANGE_REPLAYED` : stop intrabar OU TP intrabar ; si les deux
  touchés dans la même bougie → `AMBIGUOUS_STOP_FIRST` (sémantique
  conservatrice existante, désormais applicable au trailing).
- Ratchet inchangé : anchor/stop montent après évaluation complète ; si
  le TP sort, le plan est terminal (plus de ratchet).

### 2.3 CLI

`--protective-exit TRAILING_BPS --trail-bps <n> [--take-profit-bps <m>]`.

- `--take-profit-bps` devient accepté en mode TRAILING_BPS (optionnel) ;
  reste requis en FIXED_BPS / REGIME_CONDITIONAL, interdit en NONE.
- Manifeste : `protective:trailing:{trail}` sans flag,
  `protective:trailing:{trail}:{take}` avec. Suffixe :
  `-trailing-{trail}` / `-trailing-{trail}-{take}`.

## 3. Invariants

| # | Invariant |
|---|-----------|
| TT1 | `takeProfitBps` absent → plans, exits et métriques bit-identiques à v1 (T1–T3 reproductibles) |
| TT2 | `takeProfitBps` présent : ∈ ]0, 100 000[, `takeProfitPrice > entrée` sinon plan invalide (`INVALID_PROTECTIVE_PLAN`) |
| TT3 | Le TP ne modifie jamais le ratchet : anchor/stop évoluent comme en v1 jusqu'au premier exit (stop ou TP) |
| TT4 | Ambiguïté intrabar stop+TP → STOP_LOSS `AMBIGUOUS_STOP_FIRST` (réutilise la sémantique FIXED existante, conservateur) |
| TT5 | Égalité de politiques : trail ET take (présence + valeur) ; deux politiques différant seulement par take ne sont pas égales |
| TT6 | CLI : `--take-profit-bps` sans mode protectif qui l'accepte → rejet ; manifeste/suffixe étendus seulement quand le flag est présent |
| TT7 | Aucune transition machine ajoutée ; TP et trail restent des fonctions pures consommées par la machine ; aucun LLM |

## 4. Plan de mesure

Fenêtres bull/bear usuelles, gating régime identique V1 et T1–T3.
Grille 2×2 : trailBps ∈ {300, 500} × takeProfitBps ∈ {600, 900}.
Contrôles : mesures v1 T2/T3 (déjà consignées — pas de re-run, TT1
couvre la bit-identité par tests).

### Critères de succès a priori (inchangés)

- Bull : return ≥ +3 % **et** dd ≤ 10 %
- Bear : return > 0 % **et** dd ≤ 10 %
- Les deux fenêtres, même cellule.

### Attendus par mécanisme

- Si l'hypothèse de complémentarité est correcte : le TP 600 restaure
  la récolte bear (rallyes coupés à +6 %) tandis que le trail ≥ 500
  conserve le verrouillage bull.
- Diagnostic d'échec : si le TP court-circuite le trail sur le bull
  (exits TP prématurés avant les grands rebonds), la grille le montrera
  — return bull proportionnel inverse du take — et la piste suivante
  sera un TP plus large ou asymétrique.

## 5. Hors périmètre

- TP dynamique, TP par régime, armes TRAILING dans REGIME_CONDITIONAL.
- Trailing sur short.
