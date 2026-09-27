# Revue — vue portefeuille du dashboard (dao #32)

Verdict : **APPROUVÉ** (3 corrections intégrées au modèle avant approbation,
0 bloqueur ouvert).
Modèle : `dashboard-portfolio-summary.md`

## Checklist

### Cas nominaux
- [x] N produits avec derniers cycles : phase machine produit, statut
      orchestrateur, plafond produit vs consolidé côte à côte. Le prix affiché
      vient désormais d'un mark daté.
- [x] Sommes consolidées itérées en `productId` trié (S7, héritage INV-P4) :
      rejeu déterministe testé.
- [x] Produit quiescent (`halted`/`stopped`/`failed`) : dernier état
      persisté affiché, jamais masqué (S6) — cas dédié en test.
- [x] Produit jamais réveillé : `lastCycle: null`; position plate = cash connu
      et exposition nulle, position ouverte sans mark = indisponible.
- [x] Mono-produit (`portfolioSession === null`) : `kind:
      "single-product"`, réponse valide et UI inchangée (backward-compat).

### Erreurs
- [x] Snapshot incohérent → échec typé global (`INVALID_PORTFOLIO_SESSION`,
      `INVALID_PRODUCT_FACTS`, `INVALID_CONSOLIDATED_LIMITS`), aucune
      réponse partielle (S3) ; ensembles fermés de phases et statuts.
- [x] Route sans query : `limit` compris refusé `404` avant tout effet
      Agent ; `POST` refusé `405` ; sans credential `401` (mêmes statuts
      de frontière que `state`/`cycles`/`pnl`).
- [x] Échec de projection côté Agent ⇒ `500 { ok: false, error: { code } }`,
      même contrat que `/pnl`.

### Ambiguïtés et conservatisme
- [x] Statut orchestrateur en retard transitoire sur la phase machine :
      non traité comme incohérence (§2) — la revue a refusé le croisement
      phase ↔ statut qui produirait des `500` sur des états réels.
- [x] Sommes consolidées affichées ≠ sommes de décision de l'orchestrateur
      (`portfolio.context.exposure`/`dailyPnl`) : aucune substitution de
      source, aucune prétention de rejeu machine (§3.3).
- [x] Aucun verdict « conforme/dépassé » calculé : la comparaison
      exposition/plafond reste une lecture d'opérateur (S6).

### Annulations / replans / permissions
- [x] Route GET seule, lecture-seule, sans SQL ni appel sortant (S4) ;
      aucune commande, aucune écriture.
- [x] C2 vérifié : lecture portefeuille = effet de lecture supplémentaire
      dans `loading`/`refreshing`/`commanding` existants (précédent V1 de
      la revue #26) — **aucun état, événement ou transition** ajouté à
      `dashboardSessionMachine` ; ni `tradingCycleMachine` ni
      `multiProductPortfolioMachine` ne sont touchés. Aucun amendement du
      modèle de session requis.

### Transitions implicites / texte libre
- [x] Phases et statuts validés contre des ensembles fermés importés
      (`DASHBOARD_REMOTE_PHASES`, énumérations de #24) ; aucun pilotage par
      texte libre ; projection = fonction pure de `@dodash/models`, aucun
      LLM dans la chaîne.

### États terminaux
- [x] Non applicable : projection lecture-seule d'un instantané, sans cycle
      de vie propre ; les états UI restent ceux de `dashboardSessionMachine`.

### Secrets (C3)
- [x] `clientOrderId`, `exchangeOrderId`, `WorkflowError` exclus de la
      projection (S2) ; seuls `cycleId` et `productId` identifient ; aucun
      secret n'atteint le navigateur (frontière inchangée).

## Corrections demandées (appliquées au modèle avant approbation)

1. **`cash` exige fini, pas `≥ 0`** : la première mouture exigeait une
   trésorerie positive ; or une comptabilité paper peut légitimement
   frôler/zéro croiser en bord de frais — un `500` sur un état réel serait
   un fail-closed mal placé. Aligné sur la projection `/pnl` (#26) qui ne
   pose que la finitude sur `cash`. `positionQuantity` et `averagePrice`
   restent `≥ 0` (spot paper, pas de short).
2. **Sommes de lecture ≠ sommes de décision** : §3.3 précise maintenant que
   l'agrégat affiché est calculé depuis les faits produits et ne remplace
   jamais `portfolio.context.exposure`/`dailyPnl` (sources de la décision
   INV-P1/INV-P2). Évite de présenter une lecture comme un arbitrage de la
   machine.
3. **`killSwitchActive` non booléen** : ajouté aux cas
   `INVALID_PORTFOLIO_SESSION` (le champ était consommé sans être validé
   dans l'énumération des échecs).

## Vérifications d'implémentation (à faire au commit route/UI)

- V1 — La lecture portefeuille s'exécute dans le même `Promise.all` que
  `state`/`cycles`/`pnl` pendant `loading`/`refreshing` (et le rafraîchissement
  post-commande), sans nouvel état machine ni contexte supplémentaire.
- V2 — L'Agent ne fait aucune lecture SQL ni appel réseau sortant sur cette
  route : projection en mémoire de `portfolioSession` uniquement.
- V3 — Le parser du gateway revalide chaque champ (types, finitude, domaines,
  ensembles fermés) et plafonne le tableau produits (8 créneaux).
- V4 — Tests : 1 produit, N produits (ordre trié + sommes), produit
  quiescent visible, `single-product`, échecs fail-closed ; routes (auth,
  query refusée, verbe, échec 500) ; parsing client ; rendu UI avec et
  sans section portefeuille ; `test:sites` vert.

## Verdict

APPROUVÉ. Proposition additive et strictement lecture-seule : zéro
transition, zéro écriture, projection pure d'un instantané déjà restauré
fail-closed, frontière proxy inchangée, mono-produit intact. Le principal
risque (présenter une lecture d'agrégats comme la décision de l'orchestrateur)
est couvert par §3.3, S1, S3 et les corrections 1–3 ci-dessus.

## Revue complémentaire — DAO #62 (2026-09-26)

La formule de lecture issue de #32 (`marketPrice ?? averagePrice`) ne peut plus
servir de valorisation. Le dashboard consomme maintenant les marks datés de
`PortfolioProductRuntime`, montre leur qualité/âge et ne publie aucune
exposition chiffrée pour une position ouverte sans mark. Les sommes de lecture
restent distinctes de `portfolio.context.exposure` et ne remplacent jamais la
décision de l’orchestrateur.

Le mark indisponible d’un produit à quantité nulle laisse l’equity cash
exacte; le même mark manquant avec une position ouverte rend l’equity et
l’exposition indisponibles. Un mark stale garde son ancien montant clairement
qualifié.

Vérification DAO #62 : la route `/state`, le parser client, le rendu dashboard
et la compatibilité des anciennes sessions consomment les champs de qualité et
normalisent les anciennes valeurs sans provenance à `unavailable`. Tests
`models` 430/430, `agent` 264/264 et `dashboard` 45/45; TypeScript des trois
paquets réussi.
