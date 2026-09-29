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

## Revue — amendement 2026-09-28 (source d'équité paper)

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**.

- Le contrat `resolveDailyRiskWindow` reste inchangé ; `resolvePaperDailyRisk`
  est une composition pure qui choisit la source d'équité, pas un nouveau
  cycle de vie.
- Le portage inchangé sur mark indisponible est la seule option qui n'invente
  ni équité ni fenêtre ; il est explicitement fail-safe pour la migration de
  l'instance déployée (positions ouvertes, `lastPaperMark` absent).
- Le retrait du ré-ancrage paper dans l'interpréteur supprime la dernière
  entrée au coût d'acquisition vers `checkRisk`. Live et perp conservent
  `resolveDailyRiskWindow` sur l'équité réconciliée : tests de caractérisation
  exigés.
- Aucun seuil ne change. La garde `DAILY_LOSS_LIMIT` reçoit désormais un PnL
  latent réel en paper : c'est un durcissement, pas un assouplissement.
- Preuve d'origine : série AE BTC-USD 26-09 → 28-09 (inversion de signe ±9,71
  USD) dans `docs/analysis/analyse-paper-session-2026-09-28.md`.
