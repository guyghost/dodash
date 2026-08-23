# Modèle du filtre de régime

Le filtre de régime est un acteur déterministe qui classifie le marché en
trois régimes fermés — `BULLISH`, `BEARISH`, `RANGE` — à partir de snapshots
d'indicateurs causaux, puis autorise ou refuse chaque stratégie selon une carte
de permissions figée. Il ne calcule aucun prix, ne passe aucun ordre et ne
décide d'aucune taille : il ne produit qu'un état de régime consultable.

## Motivation

Les backtests 2022-2026 montrent que l'excess return se concentre en marché
baissier (rsi-reversion, PF 1,75 avec stop 300 / take 600) tandis que les
stratégies de tendance ne survivent qu'en marché haussier (breakout PF 1,55,
ema-cross sans stop en take-profit). Aucune stratégie n'est rentable dans tous
les régimes ; le filtre rend cette ségrégation explicite et modélisée plutôt
qu'implicite.

## Politique

```ts
interface RegimeFilterPolicy {
  readonly thresholdBps: number;      // séparation EMA minimale pour un régime de tendance
  readonly minObservations: number;   // bougies minimales avant tout régime confirmé
  readonly confirmationCount: number; // confirmations consécutives pour entrer ou changer de régime
}
```

Contraintes : `0 < thresholdBps < 10_000`, `1 ≤ minObservations`,
`1 ≤ confirmationCount`. Une politique invalide produit
`INVALID_REGIME_POLICY` et l'acteur termine en `failed` avant toute
observation.

## Classification brute (signal)

Chaque `CANDLE_CLOSED` porte un snapshot `{ start, emaFast, emaSlow }` calculé
en amont par la couche d'indicateurs purs, sur des bougies fermées uniquement.
La classification brute est une fonction pure fermée :

1. `emaFast > emaSlow × (1 + thresholdBps/10_000)` → `BULLISH` ;
2. `emaFast < emaSlow × (1 − thresholdBps/10_000)` → `BEARISH` ;
3. sinon → `RANGE`.

Une observation invalide (EMA non finie ou ≤ 0, timestamp non entier, non
strictement croissant) produit `INVALID_REGIME_OBSERVATION` et termine
l'acteur en `failed`. Aucune valeur future, aucun texte libre, aucun LLM.

## États et événements

```text
idle (eventless)
  ├─ politique valide ──→ warmingUp
  └─ politique invalide → failed { INVALID_REGIME_POLICY }

warmingUp
  ├─ CANDLE_CLOSED brute K, série K consécutive
  │    avec observations ≥ minObservations et série ≥ confirmationCount
  │    ─────────────────→ regimeBullish | regimeBearish | regimeRange
  ├─ CANDLE_CLOSED sinon → warmingUp (compteurs mis à jour)
  ├─ CANDLE_CLOSED invalide → failed { INVALID_REGIME_OBSERVATION }
  └─ STOP_REQUESTED ────→ stopped

regimeBullish | regimeBearish | regimeRange
  ├─ CANDLE_CLOSED brute = régime courant → même état, série opposée remise à zéro
  ├─ CANDLE_CLOSED brute opposée consécutive ≥ confirmationCount
  │    ─────────────────→ régime de la brute opposée
  ├─ CANDLE_CLOSED brute opposée isolée → même état, série opposée incrémentée
  ├─ CANDLE_CLOSED invalide → failed { INVALID_REGIME_OBSERVATION }
  └─ STOP_REQUESTED ────→ stopped
```

`failed` et `stopped` sont terminaux. Reprendre le filtrage après un état
terminal exige un nouvel acteur avec une nouvelle politique validée ; aucun
recyclage implicite.

## Hystérésis

Un changement de régime exige `confirmationCount` classifications brutes
consécutives identiques opposées au régime courant. Une seule observation
conforme au régime courant remet la série opposée à zéro. L'entrée initielle
exige simultanément `minObservations` observations totales et
`confirmationCount` brutes consécutives identiques. Cette hystérésis empêche
le claquement (flapping) autour de `thresholdBps`.

## Permissions

```ts
type RegimePermissions = Readonly<Record<RegimeKind, readonly string[]>>;
```

`resolveRegimePermission(regime, strategyId, permissions)` est pure et totale :
un `strategyId` absent de la liste du régime courant est refusé
(deny by default). La carte par défaut, figée et issue des données 2022-2026 :

| Régime | Stratégies autorisées |
| --- | --- |
| `BULLISH` | `ema-cross`, `breakout` |
| `BEARISH` | `rsi-reversion` |
| `RANGE` | `rsi-reversion` |

La carte est une entrée de configuration, jamais une décision de la machine :
la machine expose le régime, la projection applique la carte.

## Ordre des effets dans le replay

Pour chaque bougie fermée :

1. consommer le snapshot d'indicateurs causaux de la bougie ;
2. soumettre `CANDLE_CLOSED` au filtre de régime ;
3. si le régime a changé, journaliser la transition avec sa cause typée ;
4. demander la permission par stratégie pour la bougie courante ;
5. évaluer les stratégies autorisées uniquement.

Le filtre ne réordonne jamais les étapes du replay protecteur ni de
l'allocation ; il se place en amont de l'évaluation des stratégies.

## Invariants

1. La classification ne dépend que du snapshot causale de la bougie fermée.
2. Les timestamps sont strictement croissants ; une bougie est traitée une
   seule fois.
3. Aucun régime confirmé avant `minObservations` et `confirmationCount`
   consécutives.
4. Un changement de régime exige `confirmationCount` brutes opposées
   consécutives ; une observation conforme remet la série à zéro.
5. `failed` et `stopped` sont terminaux ; seul un nouvel acteur repart.
6. Les compteurs sont immuables entre deux événements.
7. Toute transition résulte d'un événement typé et de la politique figée ;
   aucun texte libre, aucun LLM, aucun score continu ne pilote un état.
8. La permission est refusée par défaut pour tout `strategyId` inconnu.
9. Le filtre ne modifie ni prix, ni taille, ni ordre : il ne fait que
   autoriser ou refuser l'évaluation d'une stratégie.
