# Signal de tendance IA — modulation bornée de la confiance (Jev)

Statut : normatif (2026-10-30). Amendement fondateur associé :
`decision-core.md` INV 5 et `README.md` INV 8-9 (notes datées 2026-10-30).

## 1. Constat

L'opérateur décide d'utiliser Jev (TypeSafe, System One) pour produire une
tendance d'achat consommée par le cycle de trading. `decision-core.md` INV 5
interdisait à toute sortie LLM de piloter une décision. Cet amendement
l'admet à condition que le LLM **module** et ne **décide** jamais : la
tendance ne crée aucun signal de stratégie, n'inverse aucune direction et
ne pilote aucune transition. Les stratégies déterministes restent les
seules origines de signaux.

Pré requis non négociables avant toute activation : adaptateur `jev` du
port via le AI Gateway de Vercel (`models/ai-decision-worker.md` §8,
modèle `typesafe-ai/jev`, clé unique `AI_GATEWAY_KEY`), et rapport de
calibration mesuré (INV 7 du port, `confidence-calibration.md`).

## 2. Résolution pure

Le cœur pur ne consomme que le type enregistré — aucun réseau dans
`models/`, aucun appel au port au moment de la décision :

```ts
type AiTrendSignal = {
  readonly kind: "AI_TREND";
  readonly productId: string;
  readonly candleClosedAt: number;   // bougie de référence de la question
  readonly observedAt: number;       // horodatage de production
  readonly bias: "UP" | "DOWN" | "NEUTRAL";   // ensemble fermé
  readonly probability: number;      // probabilité calibrée du bias, [0, 1]
  readonly provider: AiProvider;
};

type TrendPolicy = {
  readonly enabled: boolean;
  readonly maxAgeMs: number;         // fraîcheur maximale du signal
  readonly minProbability: number;   // seuil d'activation, > 0.5
  readonly maxFactor: number;        // amplitude plafond, ∈ ]1, 2]
};

type TrendModulation =
  | { kind: "INACTIVE"; reason: "DISABLED" | "STALE" | "NEUTRAL" | "BELOW_THRESHOLD" }
  | { kind: "MODULATION"; bias: "UP" | "DOWN"; factor: number };  // ∈ [1, maxFactor]
```

```ts
evaluateTrendSignal(signal: AiTrendSignal, policy: TrendPolicy, now: number)
  → TrendModulation
```

- `INACTIVE` si `enabled = false`, `now − observedAt > maxAgeMs`,
  `bias = NEUTRAL` ou `probability < minProbability`.
- Sinon `factor = 1 + (probability − minProbability) / (1 − minProbability)
  × (maxFactor − 1)` — linéaire, bornée par construction dans
  `[1, maxFactor]`, strictement positive.

Le décorateur `applyTrendModulation` (frontière stratégiale, aux côtés des
décorateurs déterministes existants) multiplie la confiance des signaux de
stratégie **alignés** avec le bias par `factor` et laisse les autres
inchangés. `factor ≥ 1 > 0` : une direction ne peut jamais être inversée,
un `HOLD` reste un `HOLD`, et l'allocation plafonne la confiance comme
aujourd'hui.

## 3. Production et consommation (effets de la coquille)

1. L'AI Worker émet une question `CHOICE` fermée (`UP`/`DOWN`/`NEUTRAL`)
   sur l'état du produit, via le port `ai-decision-worker`.
2. Le signal résultant est **persisté avant toute consommation** (pattern
   `clientOrderId` avant effet réseau) ; un échec ou refus du port ne
   produit aucun signal.
3. Une seule entrée par `(productId, candleClosedAt)` — la plus récente
   gagne, les doublons sont ignorés.
4. Le runtime de trading et le backtest consomment le même type enregistré :
   le backtest **rejoue** les signaux persistés et réutilise exactement
   `evaluateTrendSignal` + `applyTrendModulation` (INV 8 de `README.md`
   inchangé de fait).

## 4. Gates d'activation

- `SHADOW` (défaut) : les signaux sont produits et persistés, jamais
  consommés ; télémétrie seule.
- `PAPER` : modulation active dans le runtime paper uniquement, après
  rapport de calibration (ECE + courbe de fiabilité) sur des fenêtres
  figées et acceptation explicite de l'opérateur.
- `LIVE` : **interdit par ce modèle** ; nécessite un nouvel amendement daté
  approuvé par l'opérateur, sur preuve paper.

Le flag de mode est une variable de configuration figée par déploiement,
jamais une décision de machine.

## 5. Invariants

1. Le signal IA ne crée jamais de signal de stratégie et n'inverse jamais
   une direction ; il module la confiance dans `[1, maxFactor]`,
   strictement positif.
2. Le cœur pur ne consomme que le type enregistré `AiTrendSignal` ; aucun
   appel réseau dans `models/`.
3. Le signal est persisté avant toute consommation.
4. Signal absent, périmé, `NEUTRAL` ou sous seuil : décorateur identité ;
   les stratégies déterministes décident seules.
5. Le backtest rejoue les signaux enregistrés avec exactement les mêmes
   fonctions que le runtime.
6. Aucune activation `PAPER` sans rapport de calibration accepté ; `LIVE`
   interdit par ce modèle.
7. Amplitude plafonnée par `maxFactor` de la politique figée, ≤ 2.
8. Au plus un signal consommé par `(productId, candleClosedAt)`.

## 6. Vérification requise

- `evaluateTrendSignal` : chacune des quatre raisons `INACTIVE` ; seuil
  exact ; `factor` borné dans `[1, maxFactor]` sur toute la plage
  `[0, 1]` de `probability` (propriété) ; `factor > 0` partout.
- `applyTrendModulation` : confiance alignée × `factor`, opposée et `HOLD`
  inchangés ; plafond de confiance respecté.
- Déduplication `(productId, candleClosedAt)` : la plus récente gagne.
- Équivalence runtime/backtest : modulation identique sur signal enregistré.
- Test d'architecture : persistance avant consommation, aucun réseau dans
  `models/` (audit source), aucun nouvel événement ni transition de
  `tradingCycleMachine`.

## 7. Backtest des signaux enregistrés (amendement 2026-10-30)

Le backtest n'appelle jamais le fournisseur dans sa boucle : il consomme
un flux `AiTrendSignal` enregistré (§3.4) via exactement les mêmes
fonctions que le runtime (INV 8 de `README.md` inchangé de fait). Deux
protocoles complémentaires :

### A. Collecte rétrospective (batch, jours)

Pour chaque bougie passée de clôture `C`, la coquille construit l'état
**uniquement** à partir de données ≤ `C`, appelle le fournisseur via le
gateway (adaptateur Decisions, `ai-decision-worker.md` §8) et persiste le
signal avec `candleClosedAt = C` et `observedAt` = horodatage réel de
l'appel. Le backtest replay ensuite ce flux.

**Contamination possible** : le fournisseur a pu mémoriser l'histoire des
prix durant son entraînement ; ses probabilités sur les périodes
antérieures à son cutoff d'entraînement peuvent être artificiellement
bonnes. Tout rapport issu du protocole A porte l'étiquette
`RETROSPECTIVE_POSSIBLY_CONTAMINATED` ; toute mesure décisive s'appuie en
priorité sur une fenêtre postérieure au cutoff, puis sur le protocole B.

### B. Collecte prospective (SHADOW, semaines)

Le runtime produit et persiste les signaux en temps réel (§4, `SHADOW`),
sans consommation. Après la durée de collecte fixée par la politique de
calibration, le replay constitue l'out-of-sample véritable — le futur
n'existait pas au moment de la production — et fournit le rapport de
calibration ECE exigé par §4 avec les mêmes données.

Ordre : A (fenêtre récente, premier signal, go/no-go précoce) puis B en
parallèle ; l'activation `PAPER` ne se juge que sur B.

### Invariants additionnels

9. Le backtest n'émet aucun appel réseau : il replay des signaux
   enregistrés via exactement `evaluateTrendSignal` et
   `applyTrendModulation`.
10. Anti-lookahead d'entrée : l'état d'un signal de bougie `C` ne contient
    que des données ≤ `C` ; toute violation est un défaut bloquant du
    producteur, jamais une donnée de test.
11. Anti-lookahead de disponibilité : un signal consommé (runtime ou
    replay) satisfait `observedAt ≤ instant de décision` et la fraîcheur
    `maxAgeMs`.
12. Une mesure rétrospective ne valide jamais à elle seule l'activation
    `PAPER` : décision sur le protocole B uniquement.

### Vérification requise additionnelle

- Construction d'état rétrospective : une donnée postérieure à `C` dans
  l'état est rejetée (fonction pure testée).
- Replay : un signal n'est consommé que si
  `observedAt ≤ instant < observedAt + maxAgeMs`.
- L'étiquette `RETROSPECTIVE_POSSIBLY_CONTAMINATED` figure sur tout
  rapport du protocole A.

## 8. Rapport de calibration (amendement 2026-10-30)

§4 exige un rapport de calibration accepté avant toute activation
`PAPER`. Définition normative du rapport :

- **Échantillon** : chaque ligne `ai_trend_signals` (productId,
  candleClosedAt, bias, probability, collection) dans la fenêtre demandée.
- **Issue réalisée** au créneau `h` (défaut 1) : `UP | DOWN | FLAT` selon
  `close(bougie C + h·D)` comparée à `close(bougie C)` (la clôture de la
  bougie de référence est le dernier close de l'état). Une issue non
  encore close à l'instant du rapport est `PENDING` : listée, jamais
  comptée.
- **Réponse correcte** : `bias = outcome` ; `FLAT` n'est correct que pour
  `NEUTRAL`.
- **Bins** : 10 intervalles égaux sur `[0, 1]` de `probability` ; chaque
  bin porte effectif, confiance moyenne et précision (part de réponses
  correctes). La courbe de fiabilité est l'ensemble de ces bins.
- **ECE** = Σ_b (n_b / N) · |précision_b − confiance_b|.
- **Stratification obligatoire** par `collection` (SHADOW vs
  RETROSPECTIVE) ; tout rapport incluant des lignes RETROSPECTIVE porte
  l'étiquette `RETROSPECTIVE_POSSIBLY_CONTAMINATED` (INV 12).
- **Surfaces** : la lecture des lignes jointes (signal + issue) passe par
  `GET /api/agents/:name/ai-trend-calibration` ; l'ECE et les bins sont
  une fonction pure de `models/` ; le script de rapport assemble et
  affiche. Le replay backtest (§7) consomme ces mêmes lignes.

### Invariants additionnels

13. L'ECE et la courbe de fiabilité sont produits par une fonction pure de
    `models/` sur les lignes persistées ; les issues `PENDING` n'entrent
    jamais dans le calcul.
14. Aucune activation `PAPER` ne se juge sur un rapport incluant des
    lignes `PENDING` ou non stratifiées par `collection`.

### Vérification requise additionnelle (§8)

- `computeTrendCalibration` : ECE exact sur fixture figée ; bins bornés,
    vides signalés ; échantillon vide refusé explicitement.
- Jointure issue : `UP/DOWN/FLAT` selon les closes ; issue non close →
  `PENDING` ; stratification par `collection` dans le script de rapport.
