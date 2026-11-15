# Paper trading Cloudflare — analyse du 26 septembre 2026

**Verdict : le paper tourne, mais la mesure économique n'est pas fiable et la
couverture des décisions doit être qualifiée. Ces preuves ne permettent pas
de recommander un passage live.** Priorité : valorisation, causes des échecs et
qualité de la campagne, avant toute évolution du mix de stratégies.

## Périmètre et preuves

Lecture directe de l'API Cloudflare avec la session Wrangler existante :
Analytics Engine `dodash_paper_trading`, déploiements, bindings et code de
`dodash-paper-agent`. Instance `btc-usd-paper`, produits BTC-USD / ETH-USD.
Borne supérieure figée : **2026-09-26 08:51:11 UTC (10:51:11 Paris)**.

La capture de frontière montre deux cycles CANCELLED le **19 septembre à
15:54:46 UTC**, puis des portefeuilles à zéro position et 10 000 USD et une cadence
horaire à partir de **16:54:58 UTC**. Le 20 septembre 00:55Z cité dans #56 est une
borne d'analyse antérieure, pas le premier cycle de la campagne. L'instant exact
du POST /start n'a pas été récupéré : il ne faut pas l'inventer.

La fenêtre post-annulation contient **320 cycles, 160 par produit**, jusqu'au
26 septembre 08:00:24 UTC, soit environ 6,63 jours entre premier et dernier cycle.
Tous ont `_sample_interval = 1`, sans doublons produit/timestamp, sous la limite
SQL de 10 000 résultats. Les statistiques de cette fenêtre sont donc calculées
sur les observations individuelles, sans extrapolation d'échantillonnage.

Sources archivées :

- [Cycles de campagne, SQL et dates de collecte](evidence-paper-2026-09-26/campaign-cycles.json).
- [Frontière de redémarrage](evidence-paper-2026-09-26/boundaries.json) : extrait borné, pas un historique complet.
- [Synthèse reproductible](evidence-paper-2026-09-26/summary.json).
- [Code déployé : extraits](evidence-paper-2026-09-26/deployed-source-excerpts.txt),
  [provenance et empreinte du téléchargement](evidence-paper-2026-09-26/deployed-source-provenance.json).
- Captures `dodash-paper-*.json` : déploiements et bindings filtrés, sans valeurs de secrets.
- [Health checks revérifiés](evidence-paper-2026-09-26/health-recheck.json).

Reproduction hors réseau : `python3 docs/analysis/paper-session-summary-2026-09-26.py`.
Les SQL exacts sont intégrés aux captures. Pour une nouvelle fenêtre, refaire une
capture distincte et tenir compte de `_sample_interval` selon la
[documentation Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).
Les captures intermédiaires `cycles.json` et `totals.json` commencent au 20-09 ;
elles ne sont pas le dénominateur du présent rapport.

## Exploitation : activité confirmée, pas de preuve économique

- **4/4 health checks OK** après ajout d'un User-Agent navigateur. Les premières
  sondes urllib sans ce header ont reçu 403 : cela ne prouve pas une panne Worker.
- Dernière version agent : `322fe936-b6ca-4336-8047-6ec8f3ebf3f1`, déployée le
  19-09 à 15:53:29 UTC ; aucune version plus récente dans l'inventaire reçu.
- Flags déployés `LIVE_TRADING_ENABLED=false` et
  `HYPERLIQUID_PERP_TRADING_ENABLED=false`. Les seuls secrets nommés de l'agent
  sont `CONTROL_API_TOKEN` et `INTERNAL_SERVICE_TOKEN` ; bindings entre Workers
  paper. Aucun événement live/perp dans la fenêtre.
- Plus grand intervalle par produit : **60,27 minutes**. À la borne de collecte,
  dernier cycle vieux de 51 minutes : cadence horaire encore active.
- Latence moyenne des cycles : **700 ms**, maximum **3 007 ms**. Ce temps mesure
  les invocations observées ; il ne mesure pas le délai d'obtention d'une décision valide.
- Zéro `TERMINAL_FAILED`, `ORDER_OUTCOME_UNKNOWN`, `ORDER_REJECTED`, et zéro
  `ORDER_CONFIRMED` sans exécution observée. Cela ne valide pas l'ensemble des
  alertes, leur livraison ou les limites d'exposition.

La configuration ONE_DAY/horaire est documentée et cohérente avec la cadence et
les premières décisions observées. Le `/state` authentifié et les fills détaillés
n'ont pas été collectés : paramètres persistés exacts, cash et frais unitaires
restent à confirmer. Les coûts Cloudflare et l'efficacité des notifications
opérateur n'ont pas été audités.

## Résultats observés

| Mesure | BTC-USD | ETH-USD | Total |
| --- | ---: | ---: | ---: |
| Cycles | 160 | 160 | 320 |
| NO_ACTION | 108 | 87 | 195 |
| FAILED | 49 (30,6 %) | 72 (45,0 %) | **121 (37,8 %)** |
| dont STALE_MARKET_DATA terminal | 39 | 57 | **96 (30,0 %)** |
| dont RATE_LIMITED terminal | 10 | 15 | **25 (7,8 %)** |
| ORDER_CONFIRMED | 1 | 1 | **2** |
| RISK_REJECTED | 2 | 0 | 2 |
| Équité AE, toutes observations | 10 000 USD | 10 000 USD | 20 000 USD affichés |
| Position finale observée | 0,0043214386 BTC | 0,1237327704 ETH | — |

Les deux achats ont eu lieu le **22 septembre à 00:56 UTC**. Aucun autre fill
n'est observé. Une stratégie daily peut légitimement produire peu de transactions :
ce n'est pas une raison pour augmenter sa fréquence. Deux fills ne permettent
pas d'estimer une espérance ni de valider les ratios de rotation/notional de #50.

Sur les **48 cycles des dernières 24 heures** : 13 échecs RATE_LIMITED, deux
échecs STALE_MARKET_DATA, dix NO_ACTION après un RATE_LIMITED récupéré et
23 NO_ACTION sans erreur. La limitation de débit reste présente malgré la
cadence horaire : sa cause amont n'est pas identifiée par cette capture.

## Défaut confirmé : l'équité affichée est une valeur au coût d'acquisition

Le code téléchargé de Cloudflare contient :

```ts
accountEquity: portfolio.cash + portfolio.positionQuantity * portfolio.averagePrice
```

`runProductCycle` calcule séparément une équité avec le close de marché pour
la complétion du risque journalier, mais publie **`result.accountEquity`** dans AE.
Le prix moyen du broker paper intègre les frais d'achat : après les deux achats,
la valorisation au coût conserve ici exactement le capital de départ.

Conséquence : **20 000 USD affichés ne signifient pas un rendement de 0 %**.
PnL cumulatif, drawdown et comparaison entre actifs ne sont pas calculables de
façon fiable depuis cette projection seule. Les dernières valeurs `dailyPnl`
(-1,26 USD BTC et +11,20 USD ETH) ne sont ni le PnL total ni nécessairement des
marques fraîches : le dernier cycle des deux actifs a échoué sur le marché.

Le même effet paper fournit `otherExposureNotional: 0`. Ce zéro ne prouve pas
une exposition consolidée nulle ; l'orchestrateur porte un autre contrat de
risque. Aucun contournement de limite de risque n'est démontré ici.

**Suite proposée : #57**, avec prix daté, qualité fresh/stale/unavailable et
réconciliation des surfaces API/dashboard/AE. Toute conséquence sur dailyRisk
ou l'admission d'ordres doit être modélisée et revue séparément.

## Données de marché et retries : causes à distinguer

La constante de divergence ticker du Worker est toujours **100 bps**, tous
timeframes confondus. **#56 est ouverte**, non déployée : elle traite le décalage
entre prix courant et clôture journalière. Reprendre cette proposition existante.

Cependant, `STALE_MARKET_DATA` recouvre aussi l'âge de la bougie. Sur la fenêtre,
109 cycles portent ce code, mais seulement 96 terminent FAILED ; 13 terminent
NO_ACTION. AE ne porte ni la cause précise ni la raison de NO_ACTION. Il serait
incorrect d'attribuer les 96 échecs au seul ticker ou de les compter tous comme
96 décisions daily perdues. La fenêtre d'âge de deux heures et l'ordre des gardes
« bougie déjà traitée / fraîcheur » doivent être analysés par bougie éligible.

Même ambiguïté pour le rate limiting : **56 cycles portent RATE_LIMITED, 25
échouent et 31 aboutissent autrement**, dont un ordre confirmé. La machine garde
la dernière erreur rencontrée pendant le cycle. Il faut séparer diagnostic de
retry et échec terminal, sans effacer l'information de récupération.

Enfin, le Worker transforme immédiatement `retryingMarketData` en événement
`RETRY_TIMER_ELAPSED`, sans délai réel à cet endroit. Un budget borné empêche une
boucle infinie, mais les tentatives rapprochées peuvent être inutiles sous quota.
Un calendrier persistant, sensible à Retry-After et à l'expiration du signal,
est une évolution à vérifier ; ce n'est pas une garantie de disparition des 429.

**Suites proposées : #58 (diagnostic), revue de #56, puis #59 (calendrier).**
Un simple élargissement du seuil ticker ne prouve pas sa fraîcheur : son
`observedAt` doit être traité explicitement si le modèle est élargi.

## Erreur historique : la conclusion sur le signal brut doit être réexaminée

`paper-cost-decomposition-2026-09-18.mjs` calcule :

```ts
const marketPnl = totalDelta - cost;
```

Or les coûts sont positifs : **net = brut − coûts**, donc **brut = net + coûts**.
En reprenant uniquement les nombres arrondis du verdict #36 :

| Anciennes entrées | BTC-USD | ETH-USD |
| --- | ---: | ---: |
| Net publié | −647,51 USD | +10,18 USD |
| Coûts estimés publiés | 953,95 USD | 37,12 USD |
| Brut corrigé arithmétiquement | **+306,44 USD** | **+47,30 USD** |
| Brut publié à tort | −1 601,46 USD | −26,94 USD |

Cette correction arithmétique ne valide pas les données de départ, la simulation
sans coûts ou un edge positif. Le PnL moyen pendant les cycles de fill n'est pas
le PnL moyen d'un trade complet. Le drawdown du script ancien est calculé depuis
le capital initial et non depuis le maximum précédent. Une réconciliation est
nécessaire avant de réutiliser ces conclusions.

La proposition exécutée #50 cite l'ancien brut négatif. Son motif d'alignement
paper/backtest reste distinct ; ce rapport ne l'annule pas et ne recommande
aucune reprise du trading à la minute. **Suite proposée : #60**, erratum et
calculs reproductibles conservant les rapports originaux.

## Propositions créées dans swarm-dao

| Priorité | Proposition | Résultat attendu | Dépendances |
| --- | --- | --- | --- |
| P0 | **#57 — Valorisation paper** | Équité et exposition mesurées, datées et qualifiées | — |
| P1 | **#58 — Diagnostic des cycles** | Distinguer causes, retries et vraies décisions daily | — |
| P1 | **#56 — Garde ticker** (existante) | Arbitrer le contrôle selon timeframe, avec preuves de #58 | proposition existante inchangée |
| P1 | **#59 — Retry persistant** | Tentatives espacées, deadline, reprise et stop/kill sûrs | #58 |
| P1 | **#60 — Preuves historiques** | Réconcilier coûts/net/brut/drawdown et rectifier les conclusions | — |
| P2 | **#61 — Campagne probante** | Manifeste figé, couverture daily, verdict inconclusif explicite | #56, #57, #58, #59, #60 |

Les cinq propositions ont été créées avec critères structurels. Lors de la reprise
du cycle, #57 est passée à `rejected` sans aucun vote valable (0/8), parce que
Herdr ne pouvait pas créer les espaces des agents (`PermissionDenied`). Ce rejet
d’infrastructure ne constitue pas un avis du conseil. #58–#61 restent `open`,
sans délibération. Aucun de ces changements n’est contrôlé ou implémenté. Voir
[le compte rendu d’incident](../operations/incident-dao-deliberation-paper-2026-09-26.md). La #56 n'est pas dupliquée. Vérification après chaque
création : les **34 propositions précédentes sont intégralement inchangées**.
Sauvegarde préalable de `.dao` conservée dans `/private/tmp`.

Textes complets : [propositions et identifiants](paper-evolution-proposals-2026-09-26.json).
Cadrage : [modèle proposé](../../models/paper-campaign-evolution-2026-09-26.draft.md)
et [revue préparatoire](../../models/paper-campaign-evolution-2026-09-26.review.md).

Ordre conseillé : #57 et #58 en premier ; réconciliation #60 en parallèle de ces
travaux ; arbitrage #56 puis #59 sur preuves diagnostiques ; ensuite #61.
Les machines de retry et campagne doivent être formalisées en XState avant code.
Les seuils de couverture et délais restent à justifier et à figer en revue.

## Décision proposée et limites de la livraison

Continuer à considérer cette fenêtre comme une observation technique dégradée,
sans verdict de rentabilité. Après correction et revue, ouvrir une fenêtre
versionnée distincte, avec critères pré-enregistrés. Ni la date du 3/4 octobre,
ni quatorze jours écoulés, ni deux fills ne suffisent à eux seuls à valider le live.

Aucun Worker, secret, ordre, état de portefeuille ou calendrier de trading n'a
été modifié. Aucun test applicatif n'est revendiqué : cette livraison contient
analyse, preuves, modèles proposés et propositions DAO. Vérifications réalisées :
recalcul des agrégats, contrôle du non-échantillonnage et des doublons, cohérence
des comptes, inspection du code déployé et préservation de l'état DAO existant.
