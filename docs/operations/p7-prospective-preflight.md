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

### Registre local préparé, sans backend distant

Modèle : `models/p7-prospective-ledger.md`. Adaptateur de test :
`docs/analysis/p7-prospective-ledger-store.mjs`. Les fichiers SQLite sont
temporaires et étiquetés `SYNTHETIC_LOCAL_PREPARATION` ; ce sont des tests,
pas des preuves de campagne. Ne pas réutiliser la base du bot ou une autre
base existante : le store refuse les fichiers sans son propre schéma.

```sh
pnpm --filter @dodash/models build
pnpm --filter @dodash/models test -- p7-prospective-ledger.test.ts
node --test docs/analysis/p7-prospective-ledger-store.test.mjs
```

Les tests couvrent rollback, sortie réelle de processus avant/après COMMIT,
réouverture, déduplication, version de portefeuille et corruption du journal.
Une quote demandée mais non observée conduit à SUSPEND, sans refetch. Le
modèle de stockage Cloudflare et les anchors externes restent à approuver.

### Gates de source / T0

Pricing local disponible : `models/p7-prospective-pricing.md`. Le bridge
`docs/analysis/p7-prospective-pricing.mjs` prépare un résultat depuis la quote
persistée sans fetch ni écriture. Les marks sont des projections sans vente.

```sh
pnpm --filter @dodash/models build
pnpm --filter @dodash/models test -- p7-prospective-pricing.test.ts
node --test docs/analysis/p7-prospective-pricing.test.mjs
```

Résolution pricée transactionnelle **locale** disponible via `commitPricing`
du store : `models/p7-prospective-pricing-commit.md`. Requête sans prix/outcome,
revalidation après verrou et relecture, contrôle répété après insertion avant
COMMIT, rollback en cas d'expiration. Le timestamp `pricingCheckedAt` conservé
est celui avant insertion, pas une preuve de l'heure de COMMIT/flush disque.

```sh
pnpm --filter @dodash/models build
pnpm --filter @dodash/models test -- p7-prospective-pricing-commit.test.ts
node --test docs/analysis/p7-prospective-pricing-commit.test.mjs
```

Marks horaires **locaux** disponibles : `models/p7-prospective-marks.md`.
`applyMark` inscrit EXPECT/REQUEST/OBSERVE dans le journal V3 et recalcule
depuis le portefeuille relu, sans fill ou changement de balance/version.
`markCoverage` compte aussi les heures absentes du journal ; UNOBSERVED et
UNAVAILABLE sont séparés. La fenêtre courante n'entre pas prématurément dans
la couverture des heures terminées. Le signal de gap >2 h ne suspend pas
encore une campagne : la machine globale reste à implémenter.

```sh
pnpm --filter @dodash/models build
pnpm --filter @dodash/models test -- p7-prospective-marks.test.ts
node --test docs/analysis/p7-prospective-marks-store.test.mjs
```

Restent bloquants : stockage/garanties distantes, B&H, marks après fill et
final, machine globale/suspension effective, exports/anchors et autorisations
séparées. Ne pas utiliser les commandes fixtures V1 comme preuves de fills
prospectifs vérifiés. Aucune observation réelle n'est produite par ces tests.

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
