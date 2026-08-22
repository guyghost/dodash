# Modèle des sorties protectives conditionnées par régime (REGIME_CONDITIONAL)

Extension du modèle `protective-order.md` : la politique de sortie protective
n'est plus une constante de la session mais une **fonction pure du régime
actif**. La machine `protective-order` (états, transitions, résolutions
GAP_OPEN / INTRABAR / AMBIGUOUS_STOP_FIRST) est inchangée ; ce qui change est
le choix de la politique armée et son remplacement planifié lors des
transitions de régime.

## Motivation (mesuré)

Sur BTC-USD ONE_DAY, les sorties protectives FIXED 300/600 inversent leur
effet selon le régime (cf. `bull-alpha-diagnosis.md`) :

| Config | bull 2023-08→2024-08 | bear 2025-08→2026-08 |
|---|---|---|
| sans protection | +7,42 % (wr 100 %) | −15,13 % (dd 30,3 %) |
| FIXED 300/600 | −0,38 % (wr 35 %, 11 stops) | +3,70 % (dd 3,3 %) |

Le stop serré coupe les positions gagnantes en année haussière (11 stops
prématurés) et protège en année baissière. L'hypothèse : ne pas armer de
sortie en BULLISH, garder le stop 300/600 en BEARISH/RANGE/warm-up, capture
les deux côtés (~+7,4 % bull / ~+3,7 % bear). Ce document modélise ce
comportement ; les mesures de vérification sont dans `regime-exit.review.md`.

## Politique

```ts
type RegimeExitArm =
  | { readonly mode: "NONE" }
  | {
      readonly mode: "FIXED_BPS";
      readonly stopLossBps: number;   // > 0
      readonly takeProfitBps: number; // > 0
    };

interface RegimeConditionalExitPolicy {
  readonly mode: "REGIME_CONDITIONAL";
  readonly bullish: RegimeExitArm;    // défaut : NONE
  readonly bearish: RegimeExitArm;    // défaut : FIXED stop/take
  readonly range: RegimeExitArm;      // défaut : FIXED stop/take
  readonly warmUp: RegimeExitArm;     // défaut : FIXED stop/take (deny-by-default)
}
```

`ProtectiveExitPolicy` devient l'union existante plus ce variant. v1 limite
chaque bras à `NONE | FIXED_BPS` (`ATR_MULTIPLE` exclu : non mesuré ici ;
extension mécanique ultérieure). Tous les bras sont **obligatoires** : pas de
bras implicite, pas de défaut caché à la construction — les défauts
appartiennent au CLI, pas au modèle.

Contraintes : `0 < stopLossBps < 10 000`, `0 < takeProfitBps < 10 000` pour
tout bras FIXED_BPS ; sinon `INVALID_PROTECTIVE_POLICY` avant tout armement
(validation à la création de session, pas à la bougie).

## Résolution du bras actif (fonction pure)

```ts
resolveRegimeExitArm(
  policy: RegimeConditionalExitPolicy,
  regime: RegimeKind | null,   // null = warm-up / classification pending
): ActiveProtectiveExitPolicy | null
```

`null` signifie « pas de plan armé » (bras NONE). La correspondance est
totale et explicite : BULLISH→`bullish`, BEARISH→`bearish`, RANGE→`range`,
`null`→`warmUp`. Aucun autre cas n'existe par construction (union typée
fermée) ; une politique invalide ne passe jamais la validation. **Le LLM
n'intervient à aucun niveau** : le régime provient exclusivement de la
machine `regime-filter`, le bras d'un mapping figé.

## Événement de replan

`ProtectiveCancelReason` s'étend : `"POSITION_CLOSED" | "STRATEGY_EXIT" |
"REGIME_CHANGED"`. Semantique : l'annulation relève d'un changement de
politique, pas d'une sortie de position — la quantité et le prix d'entrée
moyen de la position sont inchangés. Aucun nouvel état machine ; `cancelled`
existe déjà et accepte cette raison.

## Orchestration (replay)

Le régime actif est observé à la clôture de chaque bougie (event
`CANDLE_CLOSED` de la machine régime). L'ordre par bougie N est strict :

1. Évaluation protective de N (open puis range) avec le plan armé issu de
   l'état ≤ N−1 — un plan déclenché à N l'est définitivement ;
2. Signaux, ordres, exécutions (mécanique inchangée) ;
3. Alimentation de l'observation régime N ;
4. **Point de replan** : résoudre le bras actif `arm(N)` — lu depuis
   `context.regime` de la machine régime, qui ne change qu'après une
   transition **confirmée** (`confirmationCount` satisfait) ; une brute
   isolée ne déclenche jamais de replan ;
   - si un plan est armé et `arm(N)` diffère **effectivement** du bras armé
     (mode ou paramètres) : `CANCEL_REQUESTED { reason: "REGIME_CHANGED" }`
     puis, si `arm(N) ≠ null`, armement immédiat d'un nouveau plan
     (nouveau `positionId`, quantité et `averageEntryPrice` **courants** de
     la position, `armedAt` = début N) ;
   - si `arm(N)` = null : désarmement seul ;
   - si aucun plan armé, position ouverte et `arm(N)` ≠ null : armement
     (cas NONE→FIXED en cours de position) ;
   - sinon : rien (pas de replan sans changement effectif — un flip
     BEARISH→RANGE à bras identiques ne reset pas les niveaux).

Le replan est effectif pour la bougie N+1 ; la bougie N n'est jamais
réévaluée sous deux plans. Position fermée à N ⇒ actor déjà annulé
(`POSITION_CLOSED`), le point de replan ne s'exécute pas.

## Invariants

- **RE1** — Le bras actif est une fonction pure de (politique, régime) ;
  jamais de l'historique, jamais d'une entrée non validée.
- **RE2** — Sans position, aucun plan armé, quel que soit le régime
  (hérité de protective-order.md).
- **RE3** — Replan si et seulement si le bras résolu change effectivement
  (comparaison mode + paramètres, pas identité d'objet).
- **RE4** — Un replan part toujours du prix d'entrée moyen et de la quantité
  courants ; jamais des niveaux de l'ancien plan.
- **RE5** — Deux chemins d'armement, deux sémantiques explicites : un plan
  créé au point de replan (étape 4) n'est pas évalué contre la bougie N
  (ni open ni range), il est effectif à partir de N+1 ; l'armement sur
  fill conserve la sémantique v1 (range de la bougie d'armement rejoué).
- **RE6** — Warm-up (régime `null`) suit le bras `warmUp` ; deny-by-default
  par défaut FIXE du CLI.
- **RE7** — `REGIME_CONDITIONAL` exige un `regimeFilter` actif : une config
  sans filtre est rejetée (`INVALID_BACKTEST_CONFIG` côté replay, erreur
  CLI avant exécution) — un bras dépendant d'un régime inexistant est un
  non-sens d'état.
- **RE8** — Les transitions protectives restent exclusivement celles de la
  machine `protective-order` ; l'orchestration n'émet que ses événements
  existants (ARM/CANCEL/POSITION_*/CANDLE_*), aucun bypass.
- **RE9** — Les résultats NONE et FIXED_BPS purs sont bit-identiques aux
  versions antérieures (ré solution une fois, replan jamais déclenché).

## Cas limites

- **Position ouverte pendant tout le warm-up** : bras warmUp armé à
  l'ouverture de position (l'armement existant consomme déjà le bras résolu).
- **Changement de régime la bougie d'un trigger** : le trigger N est exécuté
  (étape 1) avant le replan (étape 4) ; pas d'annulation rétroactive.
- **Réduction de position puis replan** : le replan arme sur la quantité
  restante ; l'acteur réduit est annulé et remplacé atomiquement.
- **Échec d'armement** (politique invalide détectée tard) : échec replay
  `PROTECTIVE_ORDER_FAILURE`, terminal — pas de retry implicite.

## Rétro-compatibilité

- `NONE` et `FIXED_BPS` (et `ATR_MULTIPLE` programmatique) inchangés ;
  `regimeFilter` absent + politique plate ⇒ replay bit-identique (RE9) :
  résolution une seule fois, replan jamais déclenché.
- La forme sérialisée des artefacts étend `protectiveExit.mode` avec
  `REGIME_CONDITIONAL` (bras complets sérialisés) ; lecture des artefacts
  antérieurs inchangée.
