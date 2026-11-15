# Contrat `/state` — hiérarchie portefeuille (dao #34)

Statut : MODÉLISÉ (revue incluse)
Date : 2026-09-04
Prérequis : `agent-runtime.md` (état durable, restauration fail-closed),
`multi-product-portfolio.md` (§5 orchestrateur, §9 branchement),
`dashboard-portfolio-summary.md` (projection §3, route §4, UI §5).

## 1. Problème

La réponse `/state` retourne l'état synchronisé du Durable Object. Depuis #28,
cet état contient `portfolioSession`, mais sous sa forme **runtime brute**
(contextes de machines, identifiants d'ordres, erreurs internes) : le contrat
`/state` n'expose pas la hiérarchie portefeuille — produits, phases,
expositions, session machine — comme un contrat typé et validé. La vue #32 le
contourne par sa route dédiée `/portfolio` : deux surfaces lisent la même
source sans garantie d'identité des chiffres, et la surface opérationnelle
canonique (`/state`) reste muette sur la hiérarchie.

## 2. Sources de vérité et moment du calcul

Une seule source : `TradingAgentState.portfolioSession`, restaurée fail-closed
au démarrage du DO (C3 de #28, `resolveRestoredPortfolioSession`). La
hiérarchie exposée par `/state` est **calculée à la lecture** par la même
fonction pure que la projection #32 (`projectDashboardPortfolioSummary`), sur
la même copie structurelle de l'instantané.

- Le champ ajouté n'est **jamais persisté** : `TradingAgentState` (l'état DO)
  reste inchangé. Aucune normalisation de restauration supplémentaire n'est
  requise (C3 satisfait par construction) ; une restauration refusée
  (`portfolioRestoreError`) laisse `portfolioSession` à `null` et le champ
  répond `single-product`.
- La construction de l'entrée de la projection est partagée par les deux
  surfaces : `/state` et `/portfolio` délèguent au même seam pur
  (`portfolioSession → résultat de projection`). L'identité des chiffres est
  une propriété du câblage, vérifiée par test de cohérence (ST5).

## 3. Structure du contrat

### 3.1 Forme mono-produit figée (C1)

Les champs existants de la réponse `/state` restent strictement identiques
(version, configuration, machine, enabled, schedule, portfolio, fenêtre de
risque, dailyPnl, lastTradeAt, previousIndicators, lastCycle, portfolioSession,
portfolioRestoreError, updatedAt), y compris sur les réponses de commande qui
transportent l'état. L'amendement n'ajoute **qu'un champ**, sur toutes les
réponses qui exposent l'état (lecture `GET /state` et réponses `ok` des
commandes `start`/`stop`/`reset`/`tick`/`kill`) :

```text
portfolioSummary : DashboardPortfolioSummaryResult
  = { ok: true,  value: <projection §3 de dashboard-portfolio-summary.md> }
  | { ok: false, error: { code } }   // codes fermés de #32
```

Le nom `portfolioSummary` est imposé : `portfolio` désigne déjà le portefeuille
paper mono-produit dans l'état figé (C1).

### 3.2 Contenu du champ

`value` est exactement la projection de `dashboard-portfolio-summary.md` §3 :

- `kind: "portfolio"` — phase de l'orchestrateur (session machine portefeuille),
  `killSwitchActive`, par produit : phase machine, statut d'orchestrateur,
  trésorerie/position/prix moyen, dernier close, exposition brute (formule
  `productGrossExposure`, §9.4 de #28), plafond produit, PnL quotidien,
  dernier cycle (`cycleId`, horodatages, `outcome`, `marketPrice`) ;
  consolidé : exposition et PnL quotidiens sommés en `productId` trié face à
  `portfolioRisk` ;
- `kind: "single-product"` — agent mono-produit : réponse valide, hiérarchie
  vide (§3.1 de #32), l'UI ne rend rien de nouveau.

### 3.3 Échec local fermé

Un instantané incohérent produit `{ ok: false, error: { code } }` avec les
codes fermés de #32 (`INVALID_PORTFOLIO_SESSION`, `INVALID_PRODUCT_FACTS`,
`INVALID_CONSOLIDATED_LIMITS`) — jamais une hiérarchie partielle. L'échec
reste **local au champ** : `/state` reste en 200 et ses autres champs restent
servis, la forme mono-produit figée (C1) interdisant de changer les statuts de
la route ; la surface `/portfolio` conserve son 500 dédié (#32).

## 4. Invariants

| # | Invariant |
|---|-----------|
| ST1 | `/state` reste lecture-seul : le champ est une projection pure de l'instantané, aucune écriture, aucune commande, aucun effet |
| ST2 | Forme mono-produit figée (C1) : champs additionnels uniquement, tests jumeaux obligatoires (état initial enrichi ≡ état initial sur tous les champs préexistants) |
| ST3 | Aucun secret ni identifiant d'ordre exchange (`clientOrderId`, `exchangeOrderId`), aucune erreur interne (`WorkflowError`) dans le champ ajouté ; seuls `productId` et `cycleId` identifient (S2 de #32) |
| ST4 | Instantané incohérent ⇒ échec local fermé (`{ ok: false, error: { code } }`), jamais une hiérarchie partielle ni des valeurs par défaut silencieuses |
| ST5 | Vue #32 et `/state` présentent des chiffres identiques : même fonction pure, même construction d'entrée, même instantané — test de cohérence obligatoire au commit |
| ST6 | Le champ n'est jamais persisté : aucune normalisation de restauration requise ; `portfolioRestoreError` ⇒ `single-product` |
| ST7 | Sommes itérées en `productId` trié, produits présentés dans ce même ordre (S7 de #32, héritage INV-P4) |

## 5. Convergence de la vue #32

- Le dashboard consomme la hiérarchie **depuis le contrat `/state`** : la
  section portefeuille est rendue à partir du champ validé des réponses d'état
  (chargement et rafraîchissements post-commande), plus aucune lecture
  séparée. Un fetch de moins par rafraîchissement.
- La route `/portfolio` reste la surface de projection dédiée (contrat #32
  inchangé) : elle sert de surface de contrôle de cohérence (ST5) et de lecture
  légère. Aucune allowlist n'est retirée.
- **Aucun état, événement ou transition n'est ajouté à
  `dashboardSessionMachine`** : la hiérarchie emprunte le chemin `STATE_LOADED`
  déjà validé (la réponse `/state` est revalidée dans son intégralité avant
  tout rendu). Le parseur navigateur revalide le champ avec le parseur strict
  de #32 (types, finitude, domaines, ensembles fermés, 8 créneaux) ; un champ
  `ok: false` ou malformé est une erreur typée, jamais un rendu dégradé.
- Aucune décision, aucun verdict de conformité, aucune écriture : la vue
  reste la lecture d'opérateur de #32 (S6).

## 6. Hors périmètre

- Toute écriture, toute commande, tout verdict automatique sur les plafonds.
- La forme runtime brute `portfolioSession` de `/state` (préexistante, C1 —
  non modifiée ; sa sanitisation éventuelle est un autre passage).
- Historique par produit, agrégats inter-agents, admissions live/perp.
