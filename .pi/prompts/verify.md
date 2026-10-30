---
description: "Phase 4 — vérifier l'implémentation d'un modèle (types, tests, invariants)"
argument-hint: "<nom-du-modele>"
---
Phase Verify du workflow dodash — suis le skill `dodash-workflow` (phase 4) pour « $ARGUMENTS ».

1. `pnpm --filter @dodash/models check` et `pnpm --filter @dodash/models test` (élargis à `pnpm lint` / `pnpm check` / `pnpm test` si d'autres packages sont touchés).
2. Vérifie que chaque item de la section « Vérification requise » du `.md` est couvert par un test nommé, et cite la correspondance item → test.
3. Signale tout écart entre spec, revue et implémentation.
