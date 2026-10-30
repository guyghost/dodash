# Revue — AI Worker de décisions typées, port fournisseur-agnostique (2026-10-30)

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**.

Approuvé par l'opérateur après lecture directe de la spec (2026-10-30) ;
le swarm de délibération a été retiré le même jour — le verdict humain tient
lieu de délibération.

- Le port est purement fonctionnel : aucun I/O dans `models/`, les effets
  d'appel (binding `env.AI`, HTTP OpenAI/TypeSafe) vivent dans la coquille
  `apps/agent`. Les trois fournisseurs partagent la forme System One
  (état + questions typées → probabilités sur options fermées), ce qui rend
  le port stable indépendamment du fournisseur retenu.
- Les sorties sont un union discriminé fermé (`ANSWERED` / `REFUSED` /
  `FAILED` avec `AiErrorCode`) : aucun texte libre ne sort du port, conforme
  à `decision-core.md` INV 5 et `quality-gate.md` INV 9.
- Aucun consommateur métier : la spec n'ajoute aucun événement, transition
  ni effet de trading (INV 6). Chaque consommateur suivra son propre cycle.
- La machine `idle → requesting → answered | refused | failed` est bornée :
  au plus `AI_MAX_RETRIES = 1` retry, limité à `AI_TIMEOUT` et
  `AI_PROVIDER_ERROR` ; `AI_QUOTA` et `AI_SCHEMA_MISMATCH` ne sont jamais
  rejoués ; `failed` est stable et exige `RESET` (cohérent avec
  `trading-cycle.machine.ts`).
- Calibration exigée avant toute utilisation décisionnelle (INV 7), en
  réutilisant l'approche de `confidence-calibration.md`.

## Notes d'implémentation acceptées (interprétations de la spec)

- « Niveaux non ordonnés » (§7) se vérifie par l'absence de doublons dans
  `options`/`levels` : un ensemble fermé avec doublons ne définit pas
  d'indices ordonnés univoques.
- Les identifiants de questions suivent le contrat le plus strict des
  fournisseurs (clef : lettres, chiffres, `_`, `.`, `-`, ≤ 100 caractères).
- `validateRequest` (§2) est exporté sous le nom `validateAiDecisionRequest`
  pour la cohérence avec les verbes préfixés du dépôt.
- La réponse `choice` d'OpenAI ne documente pas de probabilités par option,
  seulement la valeur choisie et sa `confidence` : la normalisation porte
  `{ [choisi]: confidence }` et l'absence de clé dans le record signifie
  « masse non rapportée », pas « probabilité nulle ».
- Les analyseurs produisent un `AiParsedDecision` (résultat sans latence) ;
  la coquille ajoute `latencyMs` mesurée pour former `AiDecisionResult`.
- Un refus partiel OpenAI (certaines réponses, pas toutes) rend la requête
  entière `REFUSED` avec les ids concernés : un refus est une réponse, la
  réponse partielle n'est jamais consommée.
- Limites acceptées : `usage.inputTokens` est facultatif (schémas d'usage
  incomplètement documentés chez clef et OpenAI) ; l'adaptateur Jev est
  différé jusqu'à l'obtention de l'accès anticipé.

## Vérification requise (§7) → couverture de tests

| Item spec | Tests |
|---|---|
| Mapping pur clef/OpenAI sur fixtures figées | `ai-decision-worker.test.ts` « clef mapping » / « openai mapping » |
| Réponse hors options → `AI_SCHEMA_MISMATCH` ; refus OpenAI → `REFUSED` avec ids | `ai-decision-worker.test.ts` « rejects out-of-schema answers » |
| Timeout → `AI_TIMEOUT` ; retry unique puis `failed` stable exigeant `RESET` | `ai-decision-worker.machine.test.ts` « retries once then fails » / « RESET returns to idle » |
| `AI_QUOTA` jamais rejoué | `ai-decision-worker.machine.test.ts` « never retries quota » |
| `validateRequest` (bornes questions/options/ids/niveaux, état hors limites) | `ai-decision-worker.test.ts` « validates requests » |
| Machine : aucun événement métier émis | `ai-decision-worker.machine.test.ts` « emits no business events » |
| Aucun appel réseau dans `models/` | `ai-decision-worker.test.ts` « performs no network access » |

## Revue de l'amendement du 2026-10-30 — Jev via le AI Gateway de Vercel

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE** (routage décidé par
l'opérateur ; preuves de catalogue et d'endpoint relevées par probe).

- Le gateway expose `/v1/decisions` à la forme OpenAI Decisions et liste
  `typesafe-ai/jev` : l'adaptateur HTTP est unique et partagé, ce qui
  supprime l'adaptateur Jev dédié et la dépendance au waitlist TypeSafe.
- Une clé unique `AI_GATEWAY_KEY` réduit la surface de secrets (§5) ; egress
  et latence du saut sont bornés par la fraîcheur `maxAgeMs` exigée du
  consommateur.
- Limite acceptée : le schéma exact des questions Jev via le gateway
  reste à confirmer au premier appel authentifié avant de compter
  l'adaptateur comme figé.
