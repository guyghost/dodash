---
description: "Phase 1 — rédiger ou amender la spec d'un modèle dans models/ (aucun code)"
argument-hint: "<nom-du-modele>"
---
Phase Model du workflow dodash — suis le skill `dodash-workflow` (phase 1) : rédige ou amende la spec de « $ARGUMENTS » dans `models/`.

Le `.md` doit contenir : `Statut : normatif (date)`, Constat, Résolution pure (signatures TypeScript), événements/transitions/effets explicites, Invariants numérotés, « Vérification requise ». Codes d'erreur fermés, aucun texte libre ne pilote une transition, les LLM n'émettent que des signaux typés. Un amendement est une section datée ajoutée, pas une réécriture.

Ne touche à aucun fichier de code : la phase Review et sa validation précèdent l'implémentation.
