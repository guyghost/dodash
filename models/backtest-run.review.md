# Revue du modèle du backtest

Le chemin nominal, l’absence de permission, le dataset invalide, les retries de chargement, l’erreur déterministe, l’annulation et les trois états terminaux sont explicites. Aucun événement texte libre n’existe et aucun LLM ne participe au workflow.

Le modèle interdit une progression décroissante ou supérieure au dataset. Les métriques ne démarrent qu’après `REPLAY_COMPLETED`, et aucun retry ne masque une divergence du cœur pur.

