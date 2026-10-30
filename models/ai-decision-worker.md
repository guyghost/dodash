# AI Worker de décisions typées — port fournisseur-agnostique (System One)

Statut : normatif (2026-10-30).

## 1. Constat

Trois fournisseurs convergent vers la même forme d'API « System One » : un
état (texte, JSON, images) plus des questions typées, contre des probabilités
sur options fermées :

- **Cloudflare Workers AI `@cf/cloudflare/clef`** (27B, multimodal) :
  questions `noul` / `choice` / `score`, probabilité par option, sortie non
  facturée, appelé via le binding `env.AI` depuis un Worker — aucune clé à
  gérer. `clef-flash` est la variante rapide du même sélecteur.
- **OpenAI Decisions** (`gpt-6-luna`, seul modèle) : questions `predicate` /
  `choice` / `score`, jusqu'à 400 questions par requête, refus typés
  (`answer.type === "refusal"`), clé `OPENAI_API_KEY`.
- **TypeSafe Jev** (System One, early access) : valeurs typées + probabilités
  calibrées, 70-500 ms, sortie gratuite, clé dédiée (accès anticipé).

Cette forme épouse exactement la règle d'architecture : options fermées
connues avant l'appel, aucune génération de texte, probabilités calibrées.
Le LLM produit des signaux ; le modèle pur décide. Sans port normalisé,
chaque fournisseur introduirait son vocabulaire d'erreur et son schéma,
contournant la règle.

Aucun consommateur métier n'est défini ici : chaque consommateur (triage de
notifications opérateur, classification de télémétrie, etc.) suivra son
propre cycle Model → Review → Implement → Verify.

## 2. Résolution pure

Le port vit dans `models/ai-decision-worker.ts` et ne contient aucun I/O.

```ts
type AiQuestion =
  | { kind: "PREDICATE"; id: string; instructions: string }
  | { kind: "CHOICE"; id: string; instructions: string;
      options: readonly string[] }              // fermé, ≥ 2 options
  | { kind: "SCORE"; id: string; instructions: string;
      levels: readonly string[] };              // fermé, ordonné, ≥ 2 niveaux

type AiAnswer =
  | { kind: "PREDICATE"; id: string; probability: number }
  | { kind: "CHOICE"; id: string;
      probabilities: Readonly<Record<string, number>> }  // clé ∈ options
  | { kind: "SCORE"; id: string; score: number };        // pondéré par niveaux

type AiErrorCode =
  | "AI_TIMEOUT" | "AI_REFUSED" | "AI_SCHEMA_MISMATCH"
  | "AI_PROVIDER_ERROR" | "AI_QUOTA";

type AiDecisionRequest =
  { provider: AiProvider; state: AiState;
    questions: readonly AiQuestion[]; timeoutMs: number };

type AiDecisionResult =
  | { kind: "ANSWERED"; answers: readonly AiAnswer[];
      latencyMs: number; inputTokens?: number }
  | { kind: "REFUSED"; refusedIds: readonly string[] }
  | { kind: "FAILED"; errorCode: AiErrorCode };
```

Fonctions de normalisation pures (une par fournisseur, effets d'appel dans la
coquille) :

- `mapClefQuestions` / `parseClefAnswers` : `noul` → `PREDICATE`,
  `choice` → `CHOICE`, `score` → `SCORE`. Une option de réponse hors
  `options`/`levels` déclarés → `AI_SCHEMA_MISMATCH`.
- `mapOpenAiQuestions` / `parseOpenAiAnswers` : `predicate` → `PREDICATE`,
  `choice` → `CHOICE`, `score` → `SCORE`. Un refus (`type: "refusal"`) est
  traduit en `REFUSED` avec les `id` concernés — un refus est une réponse,
  pas une erreur.
- `mapJevQuestions` / `parseJevAnswers` : à figer à l'obtention de l'accès
  anticipé ; le port est déjà utilisable sans cet adaptateur.

Un `AiState` hors limites (média inclus) est rejeté avant l'appel par
`validateRequest` → `AI_SCHEMA_MISMATCH`.

## 3. Machine de l'AI Worker

Machine XState dédiée `ai-decision-worker.machine.ts` :

```
idle → requesting → answered | refused | failed
```

- `requesting` porte un timeout borné (`timeoutMs`) et au plus
  `AI_MAX_RETRIES = 1` retry sur `AI_TIMEOUT` et `AI_PROVIDER_ERROR` ;
  `AI_QUOTA` et `AI_SCHEMA_MISMATCH` ne sont jamais rejoués.
- `failed` est stable et exige `RESET`, comme les autres machines du dépôt.
- La machine n'émet **aucun** événement métier : elle expose la réponse au
  consommateur, qui la traduit par une fonction pure à seuils explicites.

## 4. Politique de consommation et calibration

- Les seuils décisionnels vivent dans le cœur pur du consommateur, jamais
  dans les instructions des questions.
- Avant toute utilisation décisionnelle d'un fournisseur, sa calibration est
  mesurée sur un ensemble de questions figé (probabilités prédites vs
  fréquences observées, ECE), selon l'approche de `confidence-calibration`.
  Un fournisseur non calibré ne sort pas du stade expérimental.

## 5. Secrets

- clef : binding `AI` du Worker (wrangler), aucun secret à gérer.
- OpenAI / TypeSafe (si activés) : `wrangler secret put`, jamais dans le
  repo ni le contexte persisté ; couverts par `pnpm scan:secrets`.

## 6. Invariants

1. Aucune sortie de l'AI Worker ne pilote une transition d'état métier.
2. Les erreurs sont des codes fermés `AiErrorCode` ; aucun texte libre ne
   sort du port.
3. Un refus fournisseur est une réponse `REFUSED`, pas un échec.
4. Les options et niveaux des questions sont fermés et déclarés avant l'appel.
5. Aucune clé API n'entre dans le repo ni le contexte persisté.
6. Ce modèle n'ajoute aucun consommateur métier.
7. La calibration est mesurée avant toute utilisation décisionnelle.

## 7. Vérification requise

- Mapping pur clef et OpenAI sur fixtures figées ; réponse hors options →
  `AI_SCHEMA_MISMATCH` ; refus OpenAI → `REFUSED` avec ids.
- Timeout → `AI_TIMEOUT` ; retry unique puis `failed` stable exigeant
  `RESET` ; `AI_QUOTA` jamais rejoué.
- `validateRequest` rejette questions vides, options < 2, doublons d'id,
  niveaux non ordonnés.
- La machine n'émet aucun événement métier (assertion sur le journal
  d'événements en test).
- Aucun appel réseau dans `models/` (imports audités).
