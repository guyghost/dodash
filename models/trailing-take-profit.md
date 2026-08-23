# Exit protectif — trailing + take-profit combiné (TRAILING_BPS v2)

Statut : MESURÉ
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
| TT2 | `takeProfitBps` présent : ∈ ]0, 100 000[ validé au niveau **politique** (`INVALID_PROTECTIVE_POLICY`, comme FIXED) ; le plan revalide `takeProfitPrice > entrée` (`INVALID_PROTECTIVE_PLAN`) |
| TT3 | Le TP ne modifie jamais le ratchet : anchor/stop évoluent comme en v1 jusqu'au premier exit (stop ou TP) |
| TT4 | Ambiguïté intrabar stop+TP → STOP_LOSS `AMBIGUOUS_STOP_FIRST` (réutilise la sémantique FIXED existante, conservateur) |
| TT5 | Égalité de politiques : trail ET take, comparés par coalescence nulle (`(a.takeProfitBps ?? null) === (b.takeProfitBps ?? null)`) ; deux politiques différant seulement par take ne sont pas égales |
| TT6 | CLI : `--take-profit-bps` sans mode protectif qui l'accepte → rejet ; manifeste/suffixe étendus seulement quand le flag est présent |
| TT7 | Aucune transition machine ajoutée ; TP et trail restent des fonctions pures consommées par la machine ; aucun LLM |

## 4. Plan de mesure

Fenêtres bull/bear usuelles, gating régime identique V1 et T1–T3.
Grille 2×2 : trailBps ∈ {300, 500} × takeProfitBps ∈ {600, 900}.
Contrôles : mesures v1 T2/T3 (déjà consignées — pas de re-run, TT1
couvre la bit-identité par tests). Les `takes`/`stops` par fenêtre sont
consignés a posteriori depuis les enregistrements de trades (aucun
changement de schéma), pour distinguer « TP coupe le bull prématurément »
de « trail insuffisant ».

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

## 5. Mesures et verdict

Grille exécutée le 2025-12-17, gating EMA_THRESHOLD 100/5/3.

| cell | trail | take | bull ret | bull dd | bear ret | bear dd |
|------|-------|------|----------|---------|----------|---------|
| C1 | 300 | 600 | +0,78 % | 1,40 % | +2,39 % | 3,39 % |
| C2 | 300 | 900 | +1,62 % | 1,39 % | +1,49 % | 3,86 % |
| C3 | 500 | 600 | −0,17 % | 2,61 % | +1,96 % | 4,41 % |
| C4 | 500 | 900 | +1,05 % | 2,59 % | −0,68 % | 5,33 % |

Takes (bull/bear) : C1 6/6, C2 4/2, C3 8/8, C4 6/4. Ambiguïtés ≈ 0.

### Verdict : ÉCHEC a priori

Aucune cellule n'atteint bull ≥ +3 % (max C2 +1,62 %). Contrôles
cohérents : v1 T2/T3 déjà consignés, TT1 couverte par tests.

### Lecture mécaniste

1. **Le TP tronque la queue bull exactement comme le diagnostic
   d'échec le prévoyait** : à trail 500, retour bull inverse du take —
   T3 pur +2,61 %, take 900 → +1,05 %, take 600 → −0,17 %. Les 6–8
   sorties TP du bull sont précisément les runs qui portaient tout
   l'alpha ; les plafonder détruit la fenêtre.
2. **Bear : le take restaure partiellement la récolte** (C1 +2,39 %
   vs T2 +1,69 %) mais reste sous V1 (+3,63 %). Cause structurelle :
   co-armé sur le même plan, le ratchet monte le stop pendant le
   rallye — un repli mineur sort au stop ratcheté AVANT que le plafond
   soit atteint. Trail et take se neutralisent : le trail convertit
   les futures sorties TP en sorties stop à prix inférieur.
3. **Conclusion structurelle** : l'hypothèse « un plan uniforme pour
   les deux fenêtres » est épuisée. Chaque mécanisme domine sa
   fenêtre isolément (bull = trail 500 pur +2,61 % ; bear = fixe
   600/600 +3,63 %), mais leur combinaison sur le même plan est
   destructrice dans les deux sens.

### Piste suivante

La synthèse correcte est **par régime, pas par champ** : bras bullish
`TRAILING_BPS` 500 + bras bearish `FIXED_BPS` 600/600 dans
`REGIME_CONDITIONAL` — gate symétrique V1 inchangé (v3 n'invalide pas
les bras, seulement les seuils asymétriques). Attendu : bull ≈ T3
(+2,61 %, juste sous la barre +3 % — barre à re-discuter au modèle),
bear ≈ V1 (+3,63 %).

## 6. Hors périmètre

- TP dynamique, TP par régime, armes TRAILING dans REGIME_CONDITIONAL.
- Trailing sur short.
