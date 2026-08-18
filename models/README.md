# Modèle du cycle de trading

Ce dossier est la source de vérité des décisions d’état. La machine XState orchestre des effets externes, mais ne contient aucun calcul de trading.

## États principaux

`stopped → scheduling → waiting → fetchingMarketData → computingIndicators → evaluatingStrategies → allocating → checkingRisk`

Si un ordre existe et passe le risque :

`persistingOrderIntent → authorizing → submittingOrder → persisting → scheduling`

Si l’issue de soumission est inconnue :

`submittingOrder → reconcilingOrder → persisting`

Les retries sont explicites par phase. `failed` et `halted` sont des états stables qui exigent `RESET`.

## Événements et effets

- Le Scheduler émet `SCHEDULE_SUCCEEDED`, `SCHEDULE_FAILED` et `ALARM_FIRED`.
- Le Worker MCP émet `MARKET_DATA_READY` ou `MARKET_DATA_FAILED`.
- Le cœur pur émet les références `INDICATORS_COMPUTED`, `STRATEGIES_EVALUATED`, `ALLOCATION_COMPLETED`, puis la décision de risque.
- La coquille d’exécution persiste d’abord l’intention, fabrique un JWT éphémère, puis émet l’issue Coinbase.
- Le stockage émet `PERSIST_SUCCEEDED` ou `PERSIST_FAILED`.

Les erreurs et refus sont des codes fermés. Aucun texte libre ne pilote une transition.

## Invariants

1. Une instance d’agent ne traite qu’un cycle à la fois.
2. Aucune donnée marché périmée ne peut atteindre les indicateurs.
3. Aucun ordre ne peut être soumis sans permission de trading et approbation du risque.
4. `clientOrderId` est persisté avant tout appel réseau d’exécution.
5. Un JWT n’entre jamais dans le contexte persistant ; seuls ses temps d’émission et d’expiration sont signalés.
6. Une issue d’ordre inconnue déclenche une réconciliation, jamais un retry aveugle.
7. Après une soumission possible, l’issue est réconciliée et persistée avant arrêt ou rescheduling.
8. Le cœur fonctionnel est pur et le backtest réutilise exactement ses fonctions.
9. Un LLM ne peut produire que des signaux typés ; il ne déclenche aucune transition directement.

