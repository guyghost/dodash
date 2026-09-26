# Revue du contrat dailyRisk — DAO #62

Verdict : **APPROUVÉ, contrat inchangé**.

`resolveDailyRiskWindow(current, now, markedEquity)` ré-ouvre sa fenêtre au
changement de jour UTC et calcule `dailyPnl = markedEquity - openingEquity`.
Les appels live/perp gardent leurs snapshots réconciliés. Le chemin paper garde
les résolutions de début et de fin de cycle déjà consommées par
`trading-agent.ts` et `interpreter.ts`.

La nouvelle mesure publiée par `projectPaperValuation` n’est pas substituée à
`markedEquity`, `RiskSnapshot.dailyPnl` ou `otherExposureNotional`; elle ne
modifie ni le prédicat `DAILY_LOSS_LIMIT` ni l’admission consolidée. Toute
modification de ces sources, seuils ou conséquences exige une revue de risque
et une proposition gouvernée distinctes.

Vérification de phase : les fichiers de risque ne changent pas de calcul. La
phase Verify doit caractériser la projection `checkRisk` avec les mêmes
snapshots en amont et confirmer les mêmes décisions et transitions avant/après.
