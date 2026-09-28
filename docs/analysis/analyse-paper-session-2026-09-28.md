# Paper trading Cloudflare — analyse du 28 septembre 2026

**Verdict : la plateforme est stable et la décision journalière est prise 17 fois
sur 18 jours-produit complets, mais (1) le correctif de valorisation #62 n'est
pas déployé, donc l'équité publiée reste au coût d'acquisition ; (2) le
`dailyPnl`, entrée du garde `DAILY_LOSS_LIMIT`, est contaminé par un repli au
coût d'acquisition lors des échecs marché ; (3) une tempête de `RATE_LIMITED`
du 25 au 27 septembre a fait perdre une décision daily et montre que les retries
immédiats sont inopérants. Aucune preuve économique : deux achats, environ
−32 USD latents estimés. Pas de recommandation live.**

## Périmètre et preuves

Lecture directe de l'API Cloudflare (jeton OAuth Wrangler, compte
`bab940ffcf652079ec6172c267afa11e`) : Analytics Engine `dodash_paper_trading`,
déploiements, bindings, code déployé et `/health` des quatre Workers paper.
Prix publics Coinbase Exchange (bougies journalières et horaires, ticker) pour
les estimations de valeur de marché. Borne supérieure figée :
**2026-09-28 06:29:44 UTC**. Même borne inférieure que le rapport du 26
septembre (2026-09-19 15:54:47 UTC, annulation puis redémarrage de l'instance).

La fenêtre contient **412 cycles, 206 par produit**, du 19-09 16:54:58 UTC au
28-09 06:01:54 UTC (8,55 jours). Tous ont `_sample_interval = 1`, aucun doublon,
sous la limite SQL. Aucun événement `control.completed` ni `preflight.completed`
dans la fenêtre. Le `/state` authentifié n'a pas été lu (jeton opérateur non
disponible dans cette session) : cash et prix moyens exacts restent à confirmer.

Sources archivées dans [evidence-paper-2026-09-28/](evidence-paper-2026-09-28/) :
`campaign-cycles.json` (SQL inclus), `non-cycle-events.json`, `dataset-totals.json`,
`dodash-paper-*.json` (déploiements, bindings sans valeurs de secrets, santé),
`deployed-source-provenance.json`, `coinbase-daily-candles.json`,
`coinbase-hourly-candles.json`, `summary.json`, `mtm-estimate.json`, `sha256.json`.

Reproduction hors réseau :
`python3 docs/analysis/paper-session-summary-2026-09-28.py` et
`python3 docs/analysis/paper-mtm-estimate-2026-09-28.py`.

## Exploitation : stable, mais version figée au 19 septembre

- **4/4 `/health` OK** (User-Agent navigateur). Aucun trou : plus grand
  intervalle **60,27 min** par produit ; cadence horaire maintenue.
- **Aucun déploiement depuis le 19-09 15:53:29 UTC** sur `dodash-paper-agent`
  (version `322fe936…`), ni sur les trois autres Workers. Le code déployé émet
  toujours `schemaVersion: 2` et `accountEquity: cash + quantité × averagePrice`.
  **La PR #19 (DAO #62, valorisation datée, `schemaVersion: 3`) est fusionnée
  sur `main` mais n'est pas en production paper** : 0 ligne AE ne porte
  blob8–blob10. `LIVE_TRADING_ENABLED=false`, `HYPERLIQUID_PERP_TRADING_ENABLED=false`,
  secrets limités aux jetons internes : périmètre paper-only inchangé.
- L'heure de déclenchement dérive : 16:54:58 le 19-09 → 00:00:46 le 27-09 →
  06:01:54 le 28-09 (environ +50 s/jour : l'alarme est reprogrammée après la
  fin du cycle, pas alignée sur une grille). Sans effet observé sur la
  décision daily, mais le délai entre la clôture 00:00 UTC et la première
  évaluation varie donc de 1 à 59 minutes selon la semaine.

## Résultats observés

| Mesure | BTC-USD | ETH-USD | Total |
| --- | ---: | ---: | ---: |
| Cycles | 206 | 206 | 412 |
| NO_ACTION | 132 | 100 | 232 |
| FAILED | 70 (34,0 %) | 105 (51,0 %) | **175 (42,5 %)** |
| dont STALE_MARKET_DATA terminal | 44 | 62 | 106 |
| dont RATE_LIMITED terminal | 26 | 43 | 69 |
| ORDER_CONFIRMED | 1 | 1 | 2 |
| RISK_REJECTED | 3 | 0 | 3 |
| Équité AE (toutes lignes) | 10 000 | 10 000 | 20 000 affichés |
| Position finale | 0,0043214386 BTC | 0,1237327704 ETH | — |

Depuis la borne du 26-09 (92 cycles, 46 heures) : **54 FAILED (58,7 %)**, dont
44 `RATE_LIMITED` ; aucun fill ; un `RISK_REJECTED` BTC le 28-09 00:01 UTC.

### Le taux d'échec horaire n'est pas le bon indicateur : mesurer la couverture daily

La machine de cycle n'évalue une bougie qu'une fois (`isDuplicateDecisionCandle`)
et seulement si son âge est ≤ `maxMarketStalenessMs` = 2 h (`isFreshMarketData`).
Avec `ONE_DAY`, **la seule fenêtre de décision est 00:00–02:00 UTC, soit deux
réveils horaires** ; les 22 autres cycles du jour sont des doublons (`NO_ACTION`
sans erreur) ou des échecs sans conséquence décisionnelle. Toutes les décisions
observées (2 fills, 3 refus risque) tombent bien dans ce créneau.

| Couverture (jours-produit complets, 20-09 → 28-09) | Valeur |
| --- | ---: |
| Jours-produit avec décision valide | **17 / 18** |
| Décision prise dès le premier réveil (00:xx) | 14 / 18 |
| Décision reprise au second réveil (01:xx) | 3 / 18 |
| Décision perdue | **1 / 18 — ETH-USD 27-09** |

Le 27-09, ETH-USD a échoué en `RATE_LIMITED` de 00:00 à 06:00 (7 cycles) ; à
07:00 la bougie avait plus de 2 h : `NO_ACTION` + `STALE_MARKET_DATA`, **jamais
évaluée**. Le même mécanisme explique les 7 `NO_ACTION`/`STALE` BTC du 19-09
après redémarrage. Ce sont des **décisions daily perdues**, à distinguer des
échecs sur cycles redondants.

### `STALE_MARKET_DATA` : la garde ticker à 100 bps confirmée sur les prix publics

En rejouant les bougies horaires Coinbase contre les 412 cycles, la règle
« `STALE` ⇔ |prix courant / close daily précédent − 1| > 100 bps » prédit 349
cycles sur 412 (85 %) ; les écarts se concentrent près du seuil (le proxy est
l'open horaire, pas le ticker exact) et sur les `NO_ACTION`/`STALE` d'âge de
bougie. Exemples : BTC 21-09 (+6,7 % sur la journée) : 16 échecs `STALE` ;
BTC 28-09 : `NO_ACTION` à 01:01, puis `STALE` de 02:01 à 06:01 dès que le prix
passe sous 83 617 USD (−1 % du close 84 462,14).

Conséquence pratique : sur une politique daily, cette garde frappe surtout les
cycles redondants, **mais elle a aussi coûté un premier réveil de décision**
(ETH 21-09 00:55, rattrapé à 01:55). Elle protège d'un ticker incohérent, pas de
l'âge de la bougie ; **#56 reste la proposition à arbitrer**, avec la preuve
ci-dessus.

### `RATE_LIMITED` : tempête du 25 au 27 septembre, retries immédiats inopérants

Cycles touchés par jour (deux produits) : 7, 4, 7, 7, 8, 8 du 20 au 25-09, puis
**42 le 26-09 et 35 le 27-09**, 0 le 28-09 (7 h observées). Plus longue série :
**26 heures consécutives** (25-09 19:00 → 26-09 20:00) avec au moins un produit
limité. Répartition uniforme sur les heures UTC : pas d'effet horaire.

Le volume propre du projet est marginal (environ 4 requêtes Coinbase par heure
pour deux produits, plus les retries). Le Worker marché appelle
`api.coinbase.com/api/v3/brokerage/market/...` sans clé, depuis les IP de sortie
partagées de Cloudflare, avec un cache KV de **30 s** y compris pour des bougies
journalières closes, immuables. Les deux produits déclenchent à la même seconde.
La cause amont exacte (quota par IP partagée, politique Coinbase) n'est pas
démontrée ici ; les journaux `coinbase_*_response_failed` et `Retry-After` du
Worker marché n'ont pas été collectés.

Les retries sont bien immédiats : les cycles récupérés après 429 durent
**928 ms en moyenne**, contre 761 ms pour les échecs terminaux. Trois tentatives
en moins d'une seconde contre un limiteur de débit n'ont pratiquement aucune
chance ; seul le réveil horaire suivant « récupère », et il n'en existe qu'un
dans la fenêtre de décision.

## Défaut nouveau : `dailyPnl` contaminé par le repli au coût d'acquisition

Série BTC-USD (AE, UTC) :

```text
26-09 22:00 FAILED RATE_LIMITED   dailyPnl  -1,26
26-09 23:00 FAILED RATE_LIMITED   dailyPnl  +9,85
27-09 00:00 FAILED RATE_LIMITED   dailyPnl   0,00   <- ouverture du jour
27-09 01:00 NO_ACTION (récupéré)  dailyPnl  -9,71
27-09 02:00 FAILED                dailyPnl  -9,71
27-09 03:00 FAILED                dailyPnl   0,00
27-09 23:01 NO_ACTION             dailyPnl  -9,71
28-09 00:01 RISK_REJECTED         dailyPnl  +0,20
28-09 03:01 FAILED STALE          dailyPnl  +9,71   <- signe inversé
```

Mécanisme (code courant, `apps/agent/src/trading-agent.ts`) : l'équité marquée
vaut `cash + quantité × (lastCycle.marketPrice ?? averagePrice)`. Après **deux
échecs consécutifs**, `marketPrice` est nul et l'équité retombe au coût
d'acquisition (10 000). Si le premier cycle du jour UTC échoue, la fenêtre
`dailyRiskWindow` **s'ouvre sur cette équité au coût** : le `dailyPnl` de la
journée mesure alors `mark − coût` au lieu de `mark − mark d'ouverture`, et le
lendemain le signe s'inverse. Les deux produits ont ouvert le 27-09 sur cette
base. Or `dailyPnl` alimente le garde `DAILY_LOSS_LIMIT` de `checkRisk`. Sur
une exposition de 3 % du capital l'effet est de quelques USD ; avec des
positions pleines, un jour ouvert au coût masque ou invente une perte
journalière de l'ordre du PnL latent total. **#62 conserve volontairement cette
source pour `dailyPnl`** : le défaut persiste après déploiement de #62 et
appelle un modèle distinct.

## Valeur de marché estimée (pas une mesure)

Le Worker déployé ne publie aucune marque. Estimation depuis le `dailyPnl` du
cycle de fill (mark = close daily du 21-09), frais 6 bps, ticker Coinbase du
28-09 06:31 UTC :

| | BTC-USD | ETH-USD | Portefeuille |
| --- | ---: | ---: | ---: |
| Prix de fill estimé | 86 612 | 2 776,1 | — |
| Notional | ≈ 374 USD | ≈ 344 USD | ≈ 718 USD (3,6 % du capital) |
| Valeur au ticker | ≈ 359 USD | ≈ 328 USD | ≈ 686 USD |
| Latent | **≈ −15,6 USD** | **≈ −16,1 USD** | **≈ −31,7 USD (−0,16 %)** |

Deux achats le 22-09 00:56 UTC, aucune sortie en six jours de baisse (−4,1 % BTC,
−4,6 % ETH). Les trois `RISK_REJECTED` BTC (23-09, 25-09, 28-09, tous au réveil
de décision) sont des signaux refusés dont la raison n'est pas dans AE
(objet de #58). Les notionals (≈ 37 % de la cible `targetSignalNotional` 1 000)
suggèrent une confiance calibrée basse (`POWER_THIRD` ⇒ confiance ≈ 0,05) :
à vérifier depuis `/state`, ce n'est pas une anomalie démontrée.

Après déploiement de #62, noter qu'un mark `COINBASE_CANDLE_CLOSE` daily avec
`maxMarketStalenessMs` = 2 h sera qualifié **`stale` environ 22 h sur 24** : la
qualité de valorisation héritera de la politique de décision. Une limite de
fraîcheur propre à la valorisation (ou une marque horaire) est à modéliser.

## Propositions d'évolution

| Priorité | Évolution | Cadre | Résultat attendu |
| --- | --- | --- | --- |
| P0 | **Déployer #62 en paper** (décision opérateur distincte, nouvelle version ⇒ nouveau segment de campagne) | #62 `controlled` | Équité et exposition datées et qualifiées dans AE/API/dashboard ; fin des 10 000 USD affichés |
| P0 | **Fenêtre de risque journalier robuste aux pannes marché** : ne jamais ouvrir une fenêtre UTC ni publier `dailyPnl` sur une équité au coût ; porter le dernier mark accepté avec sa date ; qualifier `dailyPnl` (`fresh/stale/unavailable`) ; décider explicitement le comportement du garde `DAILY_LOSS_LIMIT` quand la marque est indisponible | Nouveau modèle, amendement `daily-risk` + `agent-runtime`, revue de risque | Entrée de risque déterministe ; disparition des inversions de signe |
| P1 | **Retries planifiés et persistants après 429** (déjà #59) : `nextRetryAt` persisté, `Retry-After` propagé du Worker marché à la machine, échéance = fin de la fenêtre de fraîcheur de la bougie ; décaler les deux produits de quelques secondes | #59 (dépend de #58) | Une décision daily ne dépend plus de deux réveils horaires |
| P1 | **Cache marché aligné sur l'immuabilité** : TTL long pour les bougies closes (clé déjà bornée par `start/end`), TTL court pour le ticker seul ; télémétrie des 429 amont (`Retry-After`, `cached`) dans le Worker marché | Amendement contrat service marché, `trading-telemetry` | Moins de requêtes Coinbase ; cause amont mesurable |
| P1 | **Arbitrer #56** avec la preuve ci-dessus (85 % des `STALE` expliqués par 100 bps vs close daily) : garde par timeframe ou comparaison ticker/close **horaire** pour une politique daily | #56 (existante) | Fin des échecs de fraîcheur sur les jours volatils |
| P1 | **Diagnostic des cycles** (déjà #58, rejetée sur incident de quorum) : raison fermée de `RISK_REJECTED`, cause `CANDLE_TOO_OLD` vs `TICKER_INCOHERENT`, `candleClosedAt`, compteur de tentatives, distinction terminal/récupéré | Resoumission gouvernée | Décisions et refus explicables sans lecture du Durable Object |
| P2 | **Planification alignée sur la grille** : réveils à `HH:00 + décalage` plutôt que « fin de cycle + 3 600 s » ; pour `ONE_DAY`, rafales de retry après la clôture (ex. +2, +7, +20, +45 min) plutôt qu'un réveil horaire | Amendement `multi-product-portfolio` (schedule) | Latence de décision stable ; plus de dérive |
| P2 | **Alerte campagne** : « aucune décision daily valide à 02:00 UTC » et « ≥ 6 h de 429 consécutives » ; l'alerte gelée actuelle (aucun cycle en 120 min) ne détecte ni l'un ni l'autre | `trading-telemetry` (alertes paper, sans toucher aux alertes live gelées) | Perte de décision visible le jour même |
| P2 | **Protocole de campagne** (déjà #61) : indicateur principal = couverture des décisions daily, pas taux d'échec horaire ; reconnaître qu'à une décision/jour/produit, 14 jours (≈ 28 décisions) ne peuvent pas prouver un edge : le paper `ONE_DAY` valide l'exploitation, la preuve économique vient du backtest et d'une durée bien plus longue | #61 | Verdict `inconclusive` explicite plutôt qu'un faux GO/NO-GO économique |
| P2 | **DAO** : les rejets sans bulletin (#57, #58, et sans doute #54/#55) doivent devenir un état « infrastructure failure », et #58/#59 débloqués | Incident du 26-09 | Reprise de la file de propositions |

Ordre conseillé : P0 dailyPnl (modèle + revue) en parallèle de la décision de
déploiement #62 ; puis #58 → #59 et #56 ; le cache marché peut être livré seul.
Toute machine (retry, campagne, schedule) reste à formaliser en XState avant
code, conformément à la règle Model → Review → Implement → Verify.

## Décision proposée et limites

Continuer la fenêtre comme observation d'exploitation ; ne pas la citer comme
preuve économique. Ne pas modifier la cadence horaire ni la politique daily
avant la revue des modèles ci-dessus. Aucun Worker, secret, ordre, état ou
calendrier n'a été modifié par cette analyse ; aucun test applicatif n'est
revendiqué. Vérifications effectuées : recalcul des agrégats, contrôle
d'échantillonnage et de doublons, cohérence des comptes, inspection du code
déployé et du code courant, rejeu de la règle 100 bps sur prix publics.
