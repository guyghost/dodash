# Revue du modèle du backtest

Le chemin nominal, l’absence de permission, le dataset invalide, les retries de chargement, l’erreur déterministe, l’annulation et les trois états terminaux sont explicites. Aucun événement texte libre n’existe et aucun LLM ne participe au workflow.

Le modèle interdit une progression décroissante ou supérieure au dataset. Les métriques ne démarrent qu’après `REPLAY_COMPLETED`, et aucun retry ne masque une divergence du cœur pur.

La revue anti-biais couvre désormais les erreurs classiques d’un backtest de
bougies : la décision ne peut utiliser que l’historique clos jusqu’à `t`, le
fill est différé à l’ouverture de `t+1`, la dernière décision n’est pas remplie
sans prix futur et la bougie courante incomplète est exclue. Le chargeur rejette
les pages incohérentes, les timestamps dupliqués, les trous de granularité et
toute donnée hors fenêtre. Le checksum et le manifeste rendent le run
reproductible.

Le marché modélisé est Coinbase Spot long-only. Les ventes sont bornées par la
position et les achats par le cash frais inclus ; le broker papier ne peut donc
introduire ni short ni levier absents de l’exécution cible. Les frais et le
slippage sont identiques entre scénarios et explicitement reportés.

La comparaison couvre chaque stratégie seule, leur ensemble et un buy-and-hold
sur le même dataset. Un run réussi n’est qu’un signal d’évaluation : aucune
métrique ni classement ne déclenche `LIVE_TRADING_ENABLED`, ne démarre l’Agent
ou ne crée un ordre. Erreurs, retries et annulation restent pilotés par la
machine XState ; le LLM ne décide d’aucune transition.
