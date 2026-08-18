# Règle d’architecture

Toute tâche qui modifie un workflow, une fonctionnalité métier ou une décision d’état suit obligatoirement :

1. Model
2. Review
3. Implement
4. Verify

Les fichiers de `models/` sont la source de vérité. Pour les workflows importants, utiliser une machine XState. Les événements, transitions, effets de bord et invariants doivent être explicites avant l’implémentation.

Les LLM vivent uniquement dans des AI Workers dédiés. Un LLM peut proposer, extraire, classer ou enrichir du contenu, mais il ne décide jamais d’une transition d’état. Le LLM produit des signaux ; le modèle décide.

Si le comportement ne peut pas être modélisé, il n’est pas prêt à être implémenté.

