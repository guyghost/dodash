# Persistance des fills et frais perp Hyperliquid (dao #31)

Statut : APPROUVÉ
Date : 2026-09-04
Amendement : dao #33 (2026-09-04) — rattrapage borné des fills manqués
(§2.5, invariants 11–12). Les invariants 1–10 du modèle initial sont
inchangés.
Prérequis : `hyperliquid-execution.md` (machine d'ordre, réconciliation),
`hyperliquid-orchestration.md` (runner et ports), `agent-runtime.md`
(persistance avant fin de phase), `dashboard-pnl-history.md`
(projection PnL spot — le perp en est exclu aujourd'hui),
`trading-telemetry.md` (télémétrie = signal de sortie, jamais une décision).

## 1. Problème

La table `dodash_perp_orders` persiste les intentions et statuts de soumission
Hyperliquid, mais ni les fills ni les frais. Aucun PnL perp réalisé n'est
traçable : la projection dashboard (`dashboard-pnl-history.md` §2) exclut
explicitement le perp, faute de faits. Il manque :

- la persistance de **chaque fill** (prix, quantité, frais, PnL réalisé côté
  venue) au fil de l'eau de la réconciliation perp ;
- une **projection lecture-seule** du PnL perp réalisé, consommable par le
  dashboard sur le même modèle que la projection spot.

La machine `hyperliquidPerpOrderMachine` n'est pas modifiée : aucun état,
aucun événement, aucune transition nouvelle. La persistance des fills est un
**enrichissement d'effet existant**.

## 2. Décisions

### 2.1 Schéma : table dédiée `dodash_perp_fills`

Deux options étaient ouvertes : étendre `dodash_perp_orders` ou créer une
table dédiée. **Décision : table dédiée.** Justification :

1. **Cardinalité** — un ordre produit zéro ou N fills (fills partiels, IOC
   partiellement exécuté puis annulé). `dodash_perp_orders` a une ligne par
   ordre (`client_order_id` PRIMARY KEY) ; y loger les fills imposerait une
   colonne JSON réécrite à chaque fill découvert, donc une rétroécriture de
   lignes existantes — interdit par l'invariant 3 ci-dessous.
2. **Migration** — `CREATE TABLE IF NOT EXISTS` pur : aucune `ALTER TABLE`
   sur une table existante, aucun `DROP`, aucune ligne préexistante touchée
   (backward-compat, criterion 4 du dao #31). La migration est la même au
   démarrage du Durable Object (`ensureTradingPersistenceSchema`) et au
   premier usage du store SQLite (pattern `ensurePerpOrderSchema`).
3. **Idempotence naturelle** — clé primaire composite
   `(client_order_id, fill_id)` + `INSERT OR IGNORE` : re-réconcilier un
   ordre ne duplique jamais un fill.
4. **Frontières de vérité** — les statuts d'ordre viennent de la lecture
   `orderStatus`, les fills de la lecture `userFills` : deux lectures, deux
   durées de vie, une écriture par nature insert-only pour les fills.

### 2.2 Source de vérité des fills : la venue, lue pendant la réconciliation

Les fills ne sont jamais reconstruits localement (aucun prix estimé, aucun
frais inféré, aucun PnL recalculé depuis les intentions). Ils sont lus côté
venue par le shell : endpoint Info `{"type": "userFills", "user": …}`,
filtré par le `cloid` dérivé du `clientOrderId`
(`hyperliquidCloidFromClientOrderId`). C'est le même pattern de lecture
fermée que `orderStatus`, `meta`, `clearinghouseState` et `fundingHistory`.

Un fill de la venue ne devient un fait durable que s'il est typé fermé
(`PerpFillFact`) : `fillId` (identifiant technique de trade `tid`),
`side` (`B`→`BUY`, `A`→`SELL`), `price` > 0, `quantity` > 0, `fee` ≥ 0,
`closedPnl` fini (peut être négatif ou nul), `fillTime` entier sûr.
Toute entrée portant notre `cloid` et un champ hors domaine rejette la
lecture entière (`null`) — jamais de zéro substitué, jamais un fill partiel
en vérité (pattern INV-F2 de `funding-rate-strategy.md`). Les entrées sans
notre `cloid` (ordres placés hors du bot) sont ignorées.

Le `closedPnl` de la venue est le fait autoritaire du PnL réalisé par le
fill (la mécanique de position perp n'est pas répliquée localement) ; le
frais est un champ séparé du même enregistrement.

### 2.3 Point d'ancrage : les deux effets qui closent une issue ACCEPTED

Un fill n'existe que pour un ordre accepté. Deux chemins closent une issue
`ACCEPTED` sans aucun nouvel état :

1. **l'effet de réconciliation** (`reconciling` : issue inconnue, reprise
   après crash) — la lecture venue par `cloid` est enrichie de la lecture
   des fills, persistés avant l'événement `RECONCILIATION_RESOLVED` ;
2. **l'effet de persistance de l'issue** (`persistingOutcome`) — un ordre
   accepté sans incertitude (`SUBMIT_ACCEPTED`) ne repasse jamais par
   `reconciling` : sans lecture de fills attachée à cet effet, aucun fill
   du chemin nominal ne serait jamais persisté et le PnL perp resterait
   vide. La même lecture venue par `cloid` est donc faite avant la
   persistance de l'issue.

Dans les deux cas la persistance des fills précède celle de l'issue : un
ordre `settled` a ses fills déjà écrits (« au fil de l'eau »). Une issue
`REJECTED` ne déclenche aucune lecture : rien n'a été exécuté, aucune ligne
n'est inventée.

### 2.4 Échec de fills : sobre, jamais un échec de cycle (C3)

La réconciliation et la clôture de l'issue restent prioritaires. Un échec de
lecture ou d'écriture des fills produit :

- un **log structuré** fermé (`PERP_FILLS_UNAVAILABLE` pour une lecture
  indisponible ou hors spec, `PERP_FILL_PERSIST_FAILED` pour une écriture
  refusée), sans détail libre d'API ;
- un **compteur** `fillPersistenceFailures` porté par le compte rendu de
  reprise (`HyperliquidRecoveryReport`) et par le résultat `SETTLED` du
  runner — signal de sortie télémétrie, jamais une entrée de décision
  (`trading-telemetry.md`) ;
- **jamais** un événement d'échec de machine : la machine poursuit vers
  `persistingOutcome` puis `settled`. Un `PERSIST_FAILED` de l'issue reste
  du ressort du comportement existant, inchangé.

La lecture des fills est tentée une fois par clôture d'issue ACCEPTED : pas
de boucle de retry. Un fill absent est un fait absent, jamais approximé ; il
reste rattrapable par le mécanisme borné du §2.5 (dao #33), jamais reconstruit.

### 2.5 Rattrapage borné des fills manqués (dao #33)

Point ouvert du modèle initial : un fill absent de `userFills` au moment de la
clôture (latence de la venue, interruption du bot entre soumission et
lecture) laissait un **créneau vide définitif** — un ordre `ACCEPTED` sans
aucune ligne de fill, jamais relu.

**Règle de détection (lecture-seule)** : un créneau est un ordre
`outcome = 'ACCEPTED'` sans aucune ligne dans `dodash_perp_fills`. La
détection est un `SELECT ... NOT EXISTS` borné `LIMIT`, recalculé à chaque
cycle de reprise depuis les tables existantes : aucune écriture de
détection, aucun état nouveau, aucune table ni colonne additionnelle.

**Point d'ancrage** : le rattrapage vit dans la réconciliation existante
(`recoverPending`), après la reprise des intentions en vol. Aucun nouvel
état, événement ou transition de machine (invariant 6 inchangé) ; le
rattrapage n'altère jamais les compteurs `recovered`/`unresolved` des ordres
en vol, ni le résultat d'aucun cycle.

**Rattrapage** : pour chaque créneau, la même lecture venue que §2.2
(`userFills` filtré par `cloid` — plafond 1 MiB, timeout, erreurs fermées,
couture #31/#27) est relue, puis insertion idempotente
`(client_order_id, fill_id)`. Aucune ligne n'est inventée : une venue qui ne
connaît pas le fill renvoie `[]` et le créneau reste vide (invariant 9). Un
ordre IOC accepté jamais exécuté est un créneau légitimement vide : il reste
détecté et re-relu, dont le coût est borné par le plafond ci-dessous.

**Plafond par cycle** : au plus `PERP_FILL_BACKFILL_MAX_GAPS_PER_CYCLE = 10`
créneaux relus par cycle de reprise, ordre déterministe — le plus récemment
réglé d'abord (`settled_at DESC`, puis `client_order_id DESC` pour
départage), même fenêtre que la projection §4 dont la fidélité bénéficie en
premier. Justification : chaque créneau coûte au plus une lecture venue
plafonnée (1 MiB, timeout) ; 10 borne le surcoût d'un cycle de reprise à un
ordre de grandeur sous la fenêtre de projection (50 ordres), et la
répétition cyclique garantit une couverture progressive des créneaux, du
plus frais au plus ancien. **Plafond atteint ⇒ rattrapage partiel** : les
créneaux restants sont reportés au cycle suivant (ils sortent de la
détection seulement lorsqu'ils sont comblés) et le caractère partiel est
consigné en télémétrie (`fillBackfillTruncated`).

**Télémétrie** (signal de sortie, invariant 10 inchangé) : le compte rendu
de reprise gagne quatre compteurs additifs — `fillBackfillFilled`
(créneaux comblés), `fillBackfillFailures` (créneaux en échec de
lecture/écriture), `fillBackfillUnresolved` (créneaux tournés sans fill
persisté : venue vide ou échec), `fillBackfillTruncated` (plafond atteint).
Un échec de rattrapage produit un log structuré fermé et ne fait jamais
échouer le cycle de reprise (invariant 5 étendu au rattrapage, invariant
12).

**Limite assumée** : la couture de lecture reste `userFills` (historique
récent de la venue). Un fill plus vieux que cette fenêtre n'est pas
rattrapable sans `userFillsByTime` — hors périmètre (§7), jamais approximé.

## 3. Schéma SQLite

```sql
CREATE TABLE IF NOT EXISTS dodash_perp_fills (
  client_order_id TEXT NOT NULL,
  fill_id TEXT NOT NULL,
  fill_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_order_id, fill_id)
)
```

- `fill_json` : `PerpFillFact` sérialisé — `fillId`, `side`, `price`,
  `quantity`, `fee`, `closedPnl`, `fillTime`. Aucun secret, aucune adresse
  de wallet, aucun hash de transaction, aucune signature (invariant 4).
- Le port `PerpOrderStore` gagne `persistFills` (validation fail-closed à la
  frontière : un fill mal formé est rejeté en échec typé, jamais écrit).
- Requêtes de projection : `SELECT` bornés `LIMIT`, jointure
  `client_order_id`, aucune écriture.
- Détection des créneaux (dao #33, §2.5) : `SELECT` lecture-seul avec
  `NOT EXISTS` et `LIMIT` — aucune table ni colonne nouvelle, aucune
  migration additionnelle (invariant 11).

## 4. Projection PnL perp (lecture-seule)

Projection **parallèle** à `projectDashboardPnlHistory` (décision : pas une
extension). Justification : sources de vérité distinctes
(`dodash_perp_orders`/`dodash_perp_fills` vs `dodash_cycles`/`dodash_orders`),
sémantique du PnL distincte (fait de venue `closedPnl` vs portefeuille porté
reconstitué), et zéro risque de régression sur la projection spot approuvée.
Le dashboard UI n'est pas dans ce périmètre : seule la donnée projetée existe
(fonction pure du paquet `@dodash/models`, consommable par
`dashboard-pnl-history`).

- **Fenêtre** : les N ordres perp résolus les plus récents
  (`outcome IS NOT NULL`, `ORDER BY settled_at DESC`, `N ∈ [1, 50]`,
  défaut 30) et les fills de ces ordres. La projection reçoit exactement
  cette fenêtre ; un fill dont l'ordre est hors fenêtre est ignoré.
- **Formule par fill** : `realizedPnl = closedPnl − fee` (les deux faits
  viennent du même enregistrement venue ; le frais nette le PnL réalisé).
- **Agrégats** : `totalRealizedPnl` et `totalFee`, sommes des fills de la
  fenêtre en ordre chronologique (`fillTime`, puis `fillId`).
- **Ordre d'exposition** : fills du plus récent au plus ancien.
- **Fail-closed** : ligne d'ordre ou de fill malformée (JSON non parsable,
  champ hors domaine : prix ≤ 0, frais < 0, quantité ≤ 0, timestamps non
  entiers, `outcome` hors {`ACCEPTED`, `REJECTED`, null}) produit un échec
  typé global (`INVALID_LIMIT`, `INVALID_PERP_ORDER_ROW`,
  `INVALID_PERP_INTENT_JSON`, `INVALID_PERP_FILL_ROW`,
  `INVALID_PERP_FILL_JSON`) et aucune réponse partielle. Champs absents
  légitimes (ordre sans fill) projetés comme absence, jamais en zéro.
- Chaque fill exposé porte le `productId` de l'intention persistée de son
  ordre (revalidée par `isWellFormedPerpIntent`) ; `clientOrderId` interne
  et `fillId` technique sont les seuls identifiants exposés — ni
  identifiant d'ordre exchange, ni adresse, ni hash (aligné P2 de
  `dashboard-pnl-history.md`).

## 5. Non-régression

- Lignes préexistantes de `dodash_perp_orders` : inchangées (aucune écriture
  de cette fonctionnalité ne touche la table).
- Comportement des cycles perp : identique — mêmes transitions, mêmes
  résultats `SETTLED`/`REFUSED`/`FAILED` ; seul le champ de compteur
  `fillPersistenceFailures` s'ajoute aux résultats `SETTLED` et au compte
  rendu de reprise (additif, observabilité).
- Compte rendu de reprise (dao #33) : les quatre compteurs
  `fillBackfill*` s'ajoutent (additif, observabilité) ; `recovered` et
  `unresolved` restent le compte des seuls ordres en vol.
- Mode paper, cycle spot, projection spot : non concernés.

## 6. Invariants

| # | Invariant |
|---|-----------|
| 1 | La source de vérité d'un fill est la lecture venue (`userFills` filtré par `cloid`) faite pendant un effet qui clos une issue ACCEPTED ; aucun fill n'est reconstruit, estimé ou inféré localement. |
| 2 | Idempotence par `(client_order_id, fill_id)` : `INSERT OR IGNORE`, re-réconciliation sans doublon. |
| 3 | Aucune rétroécriture : les fills sont insert-only (jamais `UPDATE`, jamais `DELETE`) et les lignes existantes de `dodash_perp_orders` ne sont jamais modifiées par cette fonctionnalité. |
| 4 | Secrets exclus : ni clé, ni signature, ni adresse de wallet, ni hash de transaction dans `fill_json`, dans la projection ou dans les logs ; seuls `fillId` (tid) et `clientOrderId` interne sont persistés. |
| 5 | Un échec de lecture ou de persistance de fills est un log structuré + un compteur, jamais un événement d'échec de machine ni un échec de cycle ; la réconciliation et la persistance de l'issue restent prioritaires (C3). |
| 6 | Aucun état, événement ou transition de `hyperliquidPerpOrderMachine` n'est ajouté ou modifié ; seule la logique d'effet du runner et du shell s'enrichit (C2). |
| 7 | Migration SQLite strictement additive (`CREATE TABLE IF NOT EXISTS`, pas de `DROP`, pas d'`ALTER` destructif), exécutée au démarrage du DO dans `ensureTradingPersistenceSchema` et idempotente au premier usage du store (C1). |
| 8 | La projection est une fonction pure lecture-seule, fenêtre bornée `LIMIT`, fail-closed globale : donnée malformée → échec typé, jamais une projection partielle ni une valeur inventée. |
| 9 | Une issue `REJECTED` ne produit aucune ligne de fill ; une absence de fill (`[]` ou lecture `null`) n'invente aucune ligne. |
| 10 | La télémétrie des fills est un signal de sortie : le compteur ne sélectionne aucune stratégie, n'approuve aucun risque et ne change aucune transition. |
| 11 | Le rattrapage (§2.5) est borné et déterministe : au plus `PERP_FILL_BACKFILL_MAX_GAPS_PER_CYCLE` créneaux par cycle de reprise, ordre `settled_at DESC, client_order_id DESC`, détection lecture-seule (`NOT EXISTS`, `LIMIT`) sans aucune écriture ni état nouveau ; plafond atteint ⇒ rattrapage partiel consigné et reporté au cycle suivant. |
| 12 | Un échec de rattrapage (détection, lecture venue ou écriture) est un log structuré + un compteur du rapport de reprise : jamais un échec de réconciliation, jamais un échec de cycle, jamais une ligne inventée (invariant 9 applicable). |

## 7. Hors périmètre

- Dashboard UI perp (rendu, route proxy) : la donnée projetée seule est
  livrée ; une route suivra un jalon dédié.
- Réconciliation périodique programmée des ordres déjà `settled`
  (planificateur dédié, au-delà du rattrapage du §2.5 déclenché par les
  cycles de reprise existants).
- Rattrapage par `userFillsByTime` des fills plus vieux que l'historique
  récent `userFills` de la venue (limite assumée du §2.5).
- Funding, positions ouvertes, PnL non réalisé, fiscalité, conversion.
- Toute écriture pilotée par la projection : lecture-seule, sans commande.
