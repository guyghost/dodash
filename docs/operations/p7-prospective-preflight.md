# Préflight — campagne shadow prospective P7 (non démarrée)

Protocole gelé : `models/p7-prospective-campaign.md`.
Revue : `models/p7-prospective-campaign.review.md`.

**Ce document n'est pas une procédure /start.** L'instance paper existante,
ses positions, sources et flags restent inchangés. Ne pas utiliser le reset
du runbook paper pour lancer cette nouvelle observation.

## Avant implémentation

- [x] Horizon choisi : 180 jours, bilans J30/J90, évaluation J180.
- [x] Étude historique séparée : verdict `SENSITIVE_TO_ASSUMPTIONS` conservé.
- [x] Limites du runtime actuel identifiées : prix close, date trigger,
  ticker last daté au fetch, marques daily, AE non exhaustif.
- [x] Opérateur approuve le protocole et ses critères numériques.
- [x] Modèle normatif et revue commités avant toute collecte prospective.

Protocole commité avant implémentation locale : `a7b5948`. La garde carnet est
un premier incrément ; elle n'est pas une validation du collector ou d'un profil.

```sh
pnpm --filter @dodash/models test -- p7-prospective-quote.test.ts
```

## Avant choix de source et date de départ

- [ ] Diagnostic fournisseurs terminé et interprété ; aucun switch automatique.
- [ ] Profil **spot BTC/ETH USD** décidé et documenté, pas de série perp.
- [ ] Carnet : horodatage amont, sequence, bid/ask, profondeur, règles de
  précision et cache vérifiés depuis l'environnement visé.
- [ ] Absence de timestamp ou carnet insuffisant => profil non prêt.
- [ ] Budget d'appels/retries figé, respecte les quotas ; pas de proxy,
  rotation d'identité ou polling agressif pour contourner les 429.
- [ ] T0 futur au minuit UTC, T1=T0+180 jours ; données pré-T0 warmup seulement.

## Avant déploiement / démarrage, autorisations séparées

- [ ] Modèle XState, manifest/ledger, pricing VWAP et assesseur testés.
- [ ] Reprise sans doublon, crash après quote/fill, refus cash/profondeur,
  boundary de 5 s/2 h/T1 et source stale/inconnue couverts.
- [ ] Stockage/export et éventuelle migration explicitement autorisés.
- [ ] Ledger et portefeuille indépendants du bot, preuves/export exacts.
- [ ] Coûts 60/2 bps **simulés** indiqués ; aucune promesse de fill réel.
- [ ] Baselines cash/B&H, valo liquidable et contrôle de complétude vérifiés.
- [ ] Déploiement isolé autorisé ; démarrage autorisé pour ce manifest précis.
- [ ] Responsable, notifications et arrêt testés ; zéro secret de trading.

## Arrêt et verdict

Un arrêt shadow n'est ni un kill du bot ni une liquidation réelle. À la fin
ou en arrêt précoce, conserver positions, refus, trous et preuves ; aucun
reset pour effacer un segment défavorable. Les résultats peuvent être
favorables, défavorables, non concluants ou invalides ; **aucun n'autorise le live**.
