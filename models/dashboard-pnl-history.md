# Historique PnL et équité du dashboard (dao #26)

Statut : APPROUVÉ
Date : 2026-09-03
Prérequis : `dashboard-session.md` (frontière proxy et machine de session),
`agent-runtime.md` (tables SQLite du Durable Object).

## 1. Problème

L'opérateur ne peut pas vérifier la performance du bot sans fouiller les logs
Cloudflare. Les faits existent déjà dans SQLite (`dodash_cycles`,
`dodash_orders`) mais aucune projection agrégée n'est exposée. Il manque :

- la **courbe d'équité** reconstruite cycle par cycle ;
- l'**historique des cycles** avec PnL réalisé, frais et slippage constaté ;
- l'état des **positions et protections ouvertes** (stop / take-profit).

Le dashboard reste une surface lecture-seule : cette proposition n'ajoute
aucune écriture, aucune commande et aucune décision.

## 2. Sources de vérité

Seules deux tables du Durable Object sont consommées. Colonnes utilisées :

```sql
dodash_cycles (
  cycle_id TEXT PRIMARY KEY,
  triggered_at INTEGER NOT NULL,
  completed_at INTEGER,
  phase TEXT NOT NULL,
  outcome TEXT NOT NULL,
  artifacts_json TEXT NOT NULL
)
dodash_orders (
  client_order_id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  status TEXT NOT NULL,
  execution_json TEXT
)
```

Champs extraits de `artifacts_json` (cycle) : dernier close de marché
(`market.candles[-1].close`), intention (`order.side`, `order.quantity`),
fill d'exécution (`execution.fill.price/quantity/fee`) et plan protecteur
(`risk.stopLossPrice`, `risk.takeProfitPrice` lorsque `risk.status=APPROVED`).

Champs extraits de `execution_json` (ordre) : `status`, `portfolio`
(`cash`, `positionQuantity`, `averagePrice` post-trade), `fill` et
`protectiveOrderId`.

Hors périmètre (aucun fait PnL traçable aujourd'hui) :

- `dodash_perp_orders` : statuts de soumission Hyperliquid, sans fill ni
  frais persistés ;
- `dodash_sell_workflows` : checkpoints de reprise, pas des faits d'exécution.

## 3. Projection

La projection est une **fonction pure** (`projectDashboardPnlHistory`) du
paquet `@dodash/models`. L'Agent lit les lignes SQL bornées puis délègue tout
calcul à cette fonction ; aucun Worker UI, proxy ou edge ne calcule un chiffre.

### 3.1 Fenêtre temporelle

- Les cycles sont sélectionnés en SQL :
  `ORDER BY triggered_at DESC LIMIT N`, `N ∈ [1, 50]`, défaut 30.
- La projection reçoit exactement cette fenêtre et la rejoue en ordre
  chronologique ascendant. Aucune lecture au-delà de la fenêtre ; une
  pagination plus profonde est une nouvelle requête.

### 3.2 Portefeuille porté

- Un ordre de la fenêtre met à jour le portefeuille porté si, et seulement
  si, `execution_json` porte un `status` `CONFIRMED`, `PROTECTION_FAILED` ou
  `NO_SELL_NEEDED` avec un `portfolio` valide (`CONFIRMED` et
  `PROTECTION_FAILED` portent aussi le fill).
- Les statuts `REJECTED`, `TERMINAL_FAILED` et `UNKNOWN` ne fournissent
  aucun fait : ni portefeuille, ni trade.
- Si plusieurs ordres partagent un même `cycle_id`, leurs lignes sont
  consommées dans l'ordre de `client_order_id` croissant ; le premier
  ordre porteur d'un fill confirme les chiffres de trade du cycle, les
  suivants ne mettent plus à jour que le portefeuille porté.
- En tête de fenêtre, le portefeuille est **inconnu** tant qu'aucune
  soumission porteuse ne s'est pas présentée : aucun point d'équité ni PnL
  n'est déduit avant ce premier portefeuille (fail-closed, pas de
  reconstruction à partir de la configuration).

### 3.3 Formules (traçables aux enregistrements bruts)

Pour chaque cycle chronologique, avec `mark` = dernier close du marché du
cycle et `fill` = fill confirmé de son ordre :

| Grandeur | Formule | Conditions |
| --- | --- | --- |
| Point d'équité | `cash + positionQuantity × mark` à `triggered_at` | `mark > 0` et portefeuille porté connu |
| Frais | `fill.fee` | ordre confirmé avec fill |
| Slippage constaté | `(fill.price − mark) / mark × 10⁴ × (+1 BUY, −1 SELL)` en bps | `mark > 0` et fill ; positif = défavorable |
| PnL réalisé | `min(previousPos, qty) × (fill.price − previousAvg) − fill.fee` sur un SELL qui réduit une position longue portée ; `null` sinon | portefeuille précédent connu (SELL et `previousPos > 0`) |
| Courbe | points d'équité ordonnés par `triggered_at` croissant | — |

`previousPos`/`previousAvg` sont ceux du portefeuille porté **avant** la
soumission courante. Un BUY ouvre : `realizedPnl = null` (rien n'est réalisé).
Un `PROTECTION_FAILED` portant un fill de vente est traité comme un SELL
(même formule) : la sortie forcée est un fait réalisé.

### 3.4 Position et protections ouvertes

- `openPosition` : dernier portefeuille porté si `positionQuantity > 0`,
  sinon `null`.
- `protection` : pour une position ouverte, le plan (`stopLossPrice`,
  `takeProfitPrice`) et la confirmation (`protectiveOrderId` présent dans la
  soumission confirmée d'achat) du **dernier BUY confirmé** portant un plan
  `APPROVED` dans la fenêtre ; si aucun plan n'est retrouvé, `protection`
  vaut `null` et l'UI affiche « non protégé » (jamais l'inverse).
- Une position fermée n'expose aucune protection.

### 3.5 Validation et échecs explicites

- Toute ligne brute malformée (JSON non parsable, champ présent mais hors
  domaine : prix ≤ 0, frais < 0, quantité ≤ 0, timestamps non entiers) produit
  un échec typé (`INVALID_CYCLE_ROW`, `INVALID_ARTIFACTS_JSON`,
  `INVALID_ORDER_ROW`, `INVALID_EXECUTION_JSON`, `INVALID_LIMIT`) et **aucune
  réponse partielle** : aucun chiffre n'est jamais inventé ou approximé.
- Champs absents (cycle sans marché, sans ordre, sans fill) sont projetés en
  `null` : c'est un état valide et affiché tel quel.

## 4. Route et frontière

| Route dashboard | Méthode | Route Agent | Corps |
| --- | --- | --- | --- |
| `/api/agents/:name/pnl?limit=N` | `GET` | `/api/agents/:name/pnl?limit=N` | interdit |

- Même enchaînement que `state` et `cycles` : rate-limit edge, origine
  same-origin, Bearer `DASHBOARD_ACCESS_TOKEN` sans branchement dépendant du
  contenu, réécriture vers le service Agent avec
  `Authorization: Bearer <CONTROL_API_TOKEN>`, réponse Agent bornée à 1 MiB.
- `limit` respecte les mêmes bornes que `cycles` (`1..50`) ; toute autre
  query est refusée `404`, tout corps `400`, toute autre méthode `405`.
- L'Agent exécute deux requêtes SQL locales (cycles bornés, ordres joints par
  `cycle_id`), sans appel réseau sortant : objectif latence p95 < 200 ms.
- Réponses : `200` projection, `500` projection en échec explicite
  (`{ ok: false, error: { code } }`), statuts de frontière inchangés.

## 5. UI lecture-seule

- La lecture PnL est un **effet de lecture supplémentaire** porté par les
  états `loading`/`refreshing` existants de `dashboardSessionMachine`, au
  même titre que `state` et `cycles`. Aucun état, événement ou transition
  n'est ajouté à la machine ; aucun contexte machine n'absorbe la projection.
- Le navigateur revalide la réponse (parser strict du gateway) avant tout
  rendu ; une réponse invalide est une erreur typée, pas un rendu dégradé.
- Rendu : courbe d'équité (SVG polynomial sur les points), tableau des
  cycles (PnL réalisé, frais, slippage), badges de protection
  (`STOP`/`TAKE-PROFIT` actifs, « non protégé » si position sans plan connu,
  « plat » sinon). Aucune décision, aucun appel d'écriture, aucune action
  conditionnée à ces chiffres.

## 6. Invariants

| # | Invariant |
|---|-----------|
| P1 | Chaque chiffre exposé est dérivé des enregistrements bruts par les formules §3.3 ; aucune interpolation, aucune extrapolation, aucune donnée hors fenêtre |
| P2 | Aucun secret, identifiant de compte, adresse de wallet, JWT ou identifiant d'ordre exchange dans la requête ou la réponse ; seul l'identifiant technique `cycle_id`, déjà exposé par `/cycles`, apparaît |
| P3 | Donnée brute malformée → échec typé global, jamais une projection partielle ni des valeurs par défaut silencieuses |
| P4 | Fenêtre bornée `1..50` cycles, lecture SQL `LIMIT` uniquement, aucun appel réseau sortant côté Agent ; la route reste GET seule et lecture-seule |
| P5 | Aucune transition, état ou événement de `dashboardSessionMachine` ni de `tradingCycleMachine` n'est ajouté ou modifié ; le LLM est absent de toute la chaîne |
| P6 | L'UI n'exécute aucune logique de décision : elle affiche la projection validée ; une position ouverte sans plan connu est affichée « non protégé » (fail-closed) |
| P7 | La réponse passe par le même proxy authentifié que `state`/`cycles` ; le secret interne n'atteint jamais le navigateur |

## 7. Hors périmètre

- Positions et PnL perpétuels Hyperliquid (pas de fills/frais persistés).
- Agrégats multi-agents, fiscalité, conversion de devise.
- Toute écriture : cette proposition n'ajoute aucune commande ni mutation.
