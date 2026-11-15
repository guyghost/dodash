# Revue — contrat `/state` hiérarchie portefeuille (dao #34)

Verdict : **APPROUVÉ** (3 corrections intégrées au modèle avant approbation,
0 bloqueur ouvert).
Modèle : `state-portfolio-contract.md`

## Checklist

### Cas nominaux
- [x] Instance portefeuille N produits : `portfolioSummary.value.kind ===
      "portfolio"` avec phases machines produits, statuts orchestrateur,
      expositions brutes (formule `productGrossExposure`), plafonds produit et
      consolidés, phase orchestrateur et kill switch — structure identique à
      la projection `/portfolio` (§3.2).
- [x] Mono-produit : `portfolioSummary = { ok: true, value: { kind:
      "single-product" } }` et **tous** les champs préexistants de `/state`
      inchangés (ST2, tests jumeaux : état initial enrichi ≡ état initial).
- [x] Restauration portfolio reflétée : une session restaurée fail-closed
      (produit stoppé compris) est visible dans `/state` avec ses phases et
      chiffres — cas dédié en test.
- [x] Restauration refusée (`portfolioRestoreError`) ⇒ `portfolioSession`
      reste `null` ⇒ `single-product` (ST6).

### Erreurs
- [x] Snapshot incohérent ⇒ `{ ok: false, error: { code } }` avec les codes
      fermés de #32, aucune hiérarchie partielle (ST4) ; cas testé sur une
      session dont un fait sort de l'ensemble fermé.
- [x] L'échec reste local au champ : `/state` reste en 200 et continue de
      servir ses autres champs ; `/portfolio` conserve son 500 dédié (#32).
- [x] Le parseur navigateur traite `ok: false` ou champ malformé comme
      `INVALID_RESPONSE` typé — jamais un rendu dégradé (§5).

### Ambiguïtés et conservatisme
- [x] Chiffres `/state` ≡ chiffres `/portfolio` par construction (même seam
      pur, même instantané) et par test de cohérence (ST5) ; aucune seconde
      dérivation indépendante qui pourrait diverger.
- [x] Les sommes de lecture restent celles de #32 (§3.3 de son modèle) : ni
      verdict, ni substitution aux sommes de décision de l'orchestrateur.

### Annulations / replans / permissions
- [x] `/state` reste GET lecture-seul, sans query ni corps ; les réponses de
      commande transportent le champ en supplément, sans changer leurs codes
      d'échec ni leurs statuts (ST1, C1).
- [x] La route `/portfolio` et ses allowlists sont conservées (surface de
      cohérence + lecture légère) ; aucune route retirée.

### Transitions implicites / texte libre
- [x] Phases et statuts validés contre les ensembles fermés importés de #32
      (`DASHBOARD_REMOTE_PHASES`, énumérations orchestrateur) — aucun
      pilotage par texte libre, aucun LLM dans la chaîne.

### États terminaux
- [x] Non applicable : projection lecture-seule d'un instantané ; aucune
      machine ajoutée ni modifiée.

### Machine de session dashboard (C2 de #32)
- [x] **Aucun nouvel état UI requis** : la hiérarchie emprunte le chemin
      `STATE_LOADED` existant (réponse `/state` déjà revalidée en bloc).
      `dashboardSessionMachine` n'est pas amendée — aucun état, événement ou
      transition ajouté ; le modèle §5 le documente.

### Secrets (C2)
- [x] Le champ ajouté exclut `clientOrderId`, `exchangeOrderId`,
      `WorkflowError` (S2 de #32) ; seuls `productId` et `cycleId`
      identifient ; test d'exclusion des clés au commit. La forme runtime
      brute `portfolioSession` (préexistante) n'est pas touchée (C1).

## Corrections demandées (appliquées au modèle avant approbation)

1. **Collision de nom `portfolio`** : la première mouture nommait le champ
   `portfolio` ; or `portfolio` désigne déjà le portefeuille paper
   mono-produit de l'état figé (C1). Renommé `portfolioSummary` — le nom
   rappelle la projection #32 dont il est le résultat exact.
2. **Statut HTTP de `/state` inchangé** : une première version faisait
   répondre `/state` en 500 sur snapshot incohérent ; c'aurait changé le
   contrat de statuts d'une surface figée par C1. Corrigé : échec local au
   champ (`{ ok: false, error: { code } }`), `/state` reste en 200, seul
   `/portfolio` conserve son 500.
3. **Réponses de commande incluses** : le champ doit aussi enrichir les
   réponses `ok` des commandes (`start`/`stop`/`reset`/`tick`/`kill`),
   sinon la vue converge sur `/state` au chargement mais garderait une
   seconde source au rafraîchissement post-commande. Le modèle §3.1 couvre
   désormais les deux chemins.

## Vérifications d'implémentation (à faire au commit code/tests)

- V1 — `/state` et toutes les réponses de commande `ok` embarquent
  `portfolioSummary` produit par le même seam pur que `/portfolio` (une
  seule construction d'entrée, une seule projection).
- V2 — Aucun champ persisté ajouté : `TradingAgentState` et
  `resolveRestoredPortfolioSession` inchangés.
- V3 — Le parseur du gateway revalide `portfolioSummary` avec le parseur
  strict de #32 (types, finitude, domaines, ensembles fermés, 8 créneaux) ;
  `ok: false` ⇒ erreur typée.
- V4 — Tests : cohérence `/state` ≡ `/portfolio` sur la même fixture ;
  jumeau mono-produit (champs préexistants `toEqual` l'état initial) ;
  restauration reflétée dans `/state` ; snapshot incohérent ⇒ code fermé ;
  exclusion des identifiants d'ordre ; routes worker (`/state`, `/portfolio`)
  ; parsing navigateur ; rendu UI avec et sans section portefeuille ;
  `test:sites` vert ; `pnpm lint` sans nouveau warning.

## Verdict

APPROUVÉ. Proposition additive strictement lecture-seule : un champ de plus
sur des réponses d'état figées par ailleurs, calculé à la lecture par la
projection #32 elle-même, jamais persisté, échec local fermé, convergence de
la vue sur le contrat `/state` sans toucher la moindre machine. Les risques
majeurs (collision `portfolio`, 500 sur surface figée, divergence
chargement/rafraîchissement) sont couverts par les corrections 1–3.
