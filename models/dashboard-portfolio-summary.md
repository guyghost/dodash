# Vue portefeuille du dashboard (dao #32)

Statut : MODÉLISÉ (revue incluse)
Date : 2026-09-04
Prérequis : `multi-product-portfolio.md` (orchestrateur §5, configuration §7,
branchement §9), `dashboard-session.md` (frontière proxy et machine de
session), `dashboard-pnl-history.md` (pattern projection + route + UI).

## 1. Problème

Le dashboard n'expose que la vue mono-produit (`/state`, `/cycles`, `/pnl`).
Une instance portefeuille multi-produits (dao #28) est invisible : l'opérateur
ne peut pas lire, sans fouiller les logs, le statut de chaque produit (phase
machine, dernier cycle, position), l'exposition engagée par produit face à son
plafond, ni les garde-fous consolidés (exposition et perte quotidienne du
portefeuille vs plafonds, kill switch). Les produits quiescents
(`stopped`/`halted`/`failed`) disparaissent de toute vue agrégée.

Le dashboard reste une surface lecture-seule : cette proposition n'ajoute
aucune écriture, aucune commande et aucune décision. La machine de session
`dashboardSessionMachine` n'est pas modifiée (C2) : la lecture portefeuille
est un effet de lecture supplémentaire porté par les états existants, au même
titre que `/pnl` (dao #26).

## 2. Sources de vérité

Une seule source : l'état synchronisé du Durable Object,
`TradingAgentState.portfolioSession` (`apps/agent/src/state.ts`), déjà
restauré fail-closed au démarrage du DO (C3 de #28). Aucune lecture SQL, aucun
appel réseau sortant. La projection consomme une copie structurelle de cet
état (l'Agent projette l'enregistrement en mémoire, il ne le reconstruit pas) :

- `configuration` (`MultiProductAgentConfiguration`, §7 de #24) : créneaux
  produits triés (`productId`, `risk` du créneau) et plafonds consolidés
  `portfolioRisk { maxGrossExposure, maxDailyLoss }` (requis pour N ≥ 2) ;
- `portfolio` (`PersistedPortfolioMachine`, orchestrateur §5 de #24) : phase
  (`validating | rejected | idle | running | draining | complete | halted`),
  `killSwitchActive` ;
- `products` (`Record<string, PortfolioProductRuntime>`) : par produit, la
  machine de cycle persistée (`value` = phase machine produit, ensemble fermé
  `DASHBOARD_REMOTE_PHASES`), le portefeuille paper (`cash`,
  `positionQuantity`, `averagePrice`), `dailyPnl`, et `lastCycle`
  (`CycleSummary` : `cycleId`, `triggeredAt`, `completedAt`, `outcome`,
  `marketPrice`).

Le statut d'orchestrateur par produit (`running | stopped | halted | failed`)
n'est pas re-dérivé par la projection : il est porté par le contexte de
l'orchestrateur, source de vérité de la quiescence (INV-P3 de #24). Ce statut
est mis à jour par l'événement terminal du produit et peut donc retarder
transitoirement la phase machine produit ; la projection n'infère jamais l'un
depuis l'autre (aucune réconciliation inventée, S3).

Hors périmètre de la projection (aucun fait consommé) :
`clientOrderId`/`exchangeOrderId` et `error` de `CycleSummary` (identifiants
d'ordre exchange et erreurs internes, C3) ; les tables SQL du DO, déjà
projetées par `/pnl` ; le PnL perp Hyperliquid.

## 3. Projection

La projection est une **fonction pure** (`projectDashboardPortfolioSummary`)
du paquet `@dodash/models`, du même pattern que `projectDashboardPnlHistory`
(dao #26) : testable sans I/O, aucun Worker UI, proxy ou edge ne calcule un
chiffre. L'Agent lit `portfolioSession`, projette l'enregistrement en entrée
structurelle et délègue tout calcul à la fonction.

### 3.1 Variante mono-produit (backward-compat)

`portfolioSession === null` (agent mono-produit classique) ⇒ projection
valide `{ kind: "single-product" }` : ce n'est ni une erreur ni une vue
dégradée, c'est la réponse d'un agent sans portefeuille. L'UI n'affiche alors
**rien** de nouveau (S6) — la vue portefeuille n'existe que pour les instances
portfolio.

### 3.2 Agrégat par produit

Pour chaque créneau de la configuration, trié par `productId` (ordre des
points de code, INV-P4 de #24) :

| Grandeur | Formule | Conditions |
| --- | --- | --- |
| Phase machine | `products[p].machine.value` | membre de `DASHBOARD_REMOTE_PHASES` |
| Statut orchestrateur | `portfolio.context.statuses[p]` | membre de `running \| stopped \| halted \| failed` |
| Position / trésorerie | `cash` (fini), `positionQuantity`, `averagePrice` du runtime | position et prix moyen `≥ 0` (spot paper, pas de short) |
| Dernier close connu | `lastCycle.marketPrice` | `null` ou `> 0` |
| Exposition brute | `\|positionQuantity\| × (marketPrice ?? averagePrice)` | même formule que `productGrossExposure` (§9.4 de #28) |
| Plafond produit | `slot.risk.maxGrossExposure` du créneau | `> 0` |
| PnL quotidien | `products[p].dailyPnl` | fini |
| Dernier cycle | `cycleId`, `triggeredAt`, `completedAt`, `outcome`, `marketPrice` | `clientOrderId`, `exchangeOrderId` et `error` exclus (C3) |

`lastCycle` est celui du runtime produit (dernier cycle **persisté et
terminé** de ce produit) ; un produit jamais réveillé projette `lastCycle:
null` et une exposition sur `averagePrice` (0 à l'initialisation).

### 3.3 Agrégat consolidé

| Grandeur | Formule |
| --- | --- |
| Phase portefeuille | `portfolio.value` (orchestrateur) |
| Kill switch | `portfolio.context.killSwitchActive` |
| Exposition consolidée | `Σ_p grossExposure_p`, sommes itérées en ordre `productId` trié (l'addition flottante n'est pas associative) |
| Plafond consolidé | `portfolioRisk.maxGrossExposure` |
| PnL quotidien consolidé | `Σ_p dailyPnl_p`, même ordre trié |
| Plafond de perte | `portfolioRisk.maxDailyLoss` |

Les sommes consolidées affichées sont calculées depuis les **faits produits**
de §3.2 : ce sont des chiffres de lecture, pas les sommes de décision de
l'orchestrateur (`portfolio.context.exposure`/`dailyPnl`, qui peuvent retarder
transitoirement). Aucune des deux sources n'est substituée à l'autre ; l'UI
ne prétend jamais que la machine a arbitré sur ces nombres exacts.

Les plafonds sont exposés tels quels (faits de configuration) ; la projection
n'affiche **pas** de verdict « conforme/dépassé » : comparer est une décision,
le dashboard les présente côte à côte et l'opérateur juge (S6, même posture
que les badges « non protégé » de #26).

### 3.4 Validation et échecs explicites

Tout écart au contrat produit un échec typé global et **aucune réponse
partielle** (`{ ok: false, error: { code } }`, statut HTTP 500) :

- `INVALID_PORTFOLIO_SESSION` : liste de produits vide, `productId` dupliqué,
  phase orchestrateur hors ensemble fermé, phase machine produit hors
  `DASHBOARD_REMOTE_PHASES`, statut orchestrateur hors ensemble fermé,
  `killSwitchActive` non booléen, `portfolioRisk` absent alors que des
  produits sont déclarés ;
- `INVALID_PRODUCT_FACTS` : champ numérique hors domaine (`cash` non fini,
  `positionQuantity` ou `averagePrice` négatifs, `dailyPnl` non fini,
  `marketPrice` présent mais `≤ 0`, plafond produit `≤ 0`, horodatage non
  entier positif, `cycleId`/`outcome` vides) ;
- `INVALID_CONSOLIDATED_LIMITS` : `maxGrossExposure` ou `maxDailyLoss` non
  finis ou `≤ 0`.

Un état réel mais transitoire (statut orchestrateur en retard sur la phase
machine, cf. §2) n'est **pas** une incohérence : aucun croisement
phase-produit ↔ statut n'est exigé.

## 4. Route et frontière

| Route dashboard | Méthode | Route Agent | Corps |
| --- | --- | --- | --- |
| `/api/agents/:name/portfolio` | `GET` | `/api/agents/:name/portfolio` | interdit |

- Même enchaînement que `state`/`cycles`/`pnl` : origine same-origin, Bearer
  `DASHBOARD_ACCESS_TOKEN` comparé sans branchement dépendant du contenu,
  réécriture vers le service Agent avec
  `Authorization: Bearer <CONTROL_API_TOKEN>`, réponse Agent bornée à 1 MiB.
- **Aucun paramètre de requête** : la projection est un instantané de l'état
  du DO, sans fenêtre ni pagination ; toute query (`limit` inclus) est
  refusée `404` avant tout effet Agent, toute autre méthode `405`.
- L'Agent exécute une lecture en mémoire de `portfolioSession` (pas de SQL,
  pas d'appel sortant) : objectif latence p95 < 50 ms.
- Réponses : `200` projection (`{ ok: true, value }`, `value.kind` valant
  `portfolio` ou `single-product`), `500` projection en échec explicite
  (`{ ok: false, error: { code } }`), statuts de frontière inchangés.
- La route est ajoutée aux allowlists GET existantes (`dashboard-api` et
  Agent) ; aucun verbe d'écriture, aucune route nouvelle côté contrôle.

## 5. UI lecture-seule

- La lecture portefeuille est un **effet de lecture supplémentaire** porté
  par les états `loading`/`refreshing`/`commanding` existants de
  `dashboardSessionMachine`, au même titre que `state`, `cycles` et `pnl`
  (V1 de la revue #26). **Aucun état, événement ou transition n'est ajouté à
  la machine** (C2) ; aucun contexte machine n'absorbe la projection.
- Le navigateur revalide la réponse (parser strict du gateway : types,
  finitude, plafonds de tailles — produits bornés par le nombre de créneaux
  admissibles, 8) avant tout rendu ; une réponse invalide est une erreur
  typée, pas un rendu dégradé.
- Rendu, dans le prolongement de la section « 07 PERFORMANCE » (nouvelle
  section « 08 PORTEFEUILLE », les perpétuels passant en 09) : une carte par
  produit (identifiant, phase machine, statut d'orchestrateur, dernier cycle,
  position, exposition brute vs plafond produit), une carte consolidée
  (phase portefeuille, kill switch, exposition consolidée vs plafond, PnL
  quotidien consolidé vs plafond de perte). **Les produits quiescents
  restent visibles** avec leurs derniers chiffres connus (INV-P3 côté
  affichage).
- `kind === "single-product"` ⇒ la section n'est pas rendue : un agent
  mono-produit garde exactement l'écran d'aujourd'hui (backward-compat).
- Aucune décision, aucun appel d'écriture, aucune action conditionnée à ces
  chiffres ; aucun verdict de conformité calculé côté UI.

## 6. Invariants

| # | Invariant |
|---|-----------|
| S1 | Chaque chiffre exposé est dérivé de l'état du DO par les formules §3.2/§3.3 ; l'exposition brute d'un produit utilise exactement la formule de `productGrossExposure` (§9.4 de #28) ; aucune interpolation, aucune reconstruction |
| S2 | Aucun secret, aucun identifiant d'ordre exchange (`clientOrderId`, `exchangeOrderId`), aucune adresse, aucun JWT ni `WorkflowError` interne dans la projection ; seuls `cycleId` (déjà exposé par `/cycles`) et `productId` identifient |
| S3 | Instantané incohérent → échec typé global (`§3.4`), jamais une projection partielle ni des valeurs par défaut silencieuses ; les écarts transitoires documentés (§2) ne sont pas des incohérences |
| S4 | Route GET seule, lecture-seule, sans query ni corps, sans SQL ni appel réseau sortant côté Agent ; mêmes statuts de frontière que `state`/`cycles`/`pnl` ; le secret interne n'atteint jamais le navigateur |
| S5 | Aucune transition, état ou événement de `dashboardSessionMachine`, `tradingCycleMachine` ou `multiProductPortfolioMachine` n'est ajouté ou modifié (C2) ; aucun LLM dans la chaîne |
| S6 | L'UI n'exécute aucune logique de décision : elle affiche la projection validée ; `single-product` ⇒ aucune section rendue ; produits quiescents toujours listés, jamais masqués |
| S7 | Sommes consolidées itérées en ordre `productId` trié (déterminisme, héritage INV-P4 de #24) ; produits présentés dans ce même ordre |

## 7. Hors périmètre

- Historique et courbe d'équité par produit (la fenêtre `/pnl` reste la vue
  de performance) ; agrégats inter-agents (un DO = un portefeuille).
- Verdicts de conformité, alertes ou notifications dérivées des plafonds.
- Admissions live/perp par créneau (C4 de #24), toute écriture ou commande.

## 8. Convergence sur le contrat `/state` (dao #34)

Amendement postérieur : la hiérarchie portefeuille est désormais exposée par
le contrat `/state` lui-même — champ additionnel `portfolioSummary`, résultat
de la présente projection (§3), calculé à la lecture sur le même instantané.
Contrat, invariants et revue : `models/state-portfolio-contract.md` (dao #34).

- La vue (§5) consomme ce champ des réponses `/state` (et des réponses de
  commande qui transportent l'état) : plus aucune lecture `/portfolio` par le
  dashboard.
- La route `/portfolio` (§4) est conservée à contrat inchangé : surface de
  contrôle de cohérence avec `/state` (chiffres identiques exigés, test au
  commit) et lecture légère.
- Aucun état, événement ou transition de `dashboardSessionMachine` n'est
  ajouté : la hiérarchie emprunte le chemin `STATE_LOADED` existant.
