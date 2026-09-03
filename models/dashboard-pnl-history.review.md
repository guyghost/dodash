# Revue — historique PnL et équité du dashboard (dao #26)

Verdict : **APPROUVÉ** (2 corrections intégrées au modèle avant approbation,
0 bloqueur ouvert).
Modèle : `dashboard-pnl-history.md`

## Checklist

### Cas nominaux
- [x] Cycle avec BUY confirmé, fill et mark présents : point d'équité,
      frais, slippage défavorable-positif, PnL `null` (ouverture) —
      formules §3.3 reprises à l'identique dans la projection pure.
- [x] SELL qui réduit une position portée : PnL réalisé sur le
      portefeuille précédent, frais soustraits ; `PROTECTION_FAILED`
      portant un fill traité comme sortie réalisée.
- [x] Cycles sans ordre ou sans marché : `null` affichés, pas d'erreur.
- [x] Fenêtre vide : courbe vide, tableau vide, position `null` — cas
      vide testé.
- [x] Pagination : SQL `LIMIT N`, `N ∈ [1, 50]`, la projection rejoue
      uniquement la fenêtre reçue (P4).

### Erreurs
- [x] JSON malformé ou champ hors domaine → échec typé global, aucune
      réponse partielle (P3) ; codes fermés énumérés §3.5.
- [x] Statuts `REJECTED`/`TERMINAL_FAILED`/`UNKNOWN` : aucun fait
      consommé (pas de portefeuille fantôme après un échec).
- [x] `limit` hors bornes ou query additionnelle → `404` au proxy,
      avant tout effet Agent.

### Ambiguïtés et conservatisme
- [x] Premier portefeuille inconnu en tête de fenêtre : aucun chiffre
      déduit avant la première soumission porteuse (§3.2) — la revue a
      refusé l'amorçage par `initialCapital` de la configuration
      (donnée d'état, pas un enregistrement brut daté).
- [x] Position ouverte sans plan retrouvé → « non protégé » affiché
      (P6, fail-closed) ; jamais un badge de protection déduit d'un
      cycle antérieur à la fenêtre sans fill confirmé.

### Annulations / replans / permissions
- [x] Route GET seule, lecture-seule : aucune commande, aucun état
      machine modifié (P5) ; mêmes permissions et mêmes statuts de
      frontière que `state`/`cycles` (P7).

### Transitions implicites / texte libre
- [x] Aucune transition pilotée par texte libre ; la projection est une
      fonction pure de `@dodash/models`, consommée par l'Agent ; aucun
      LLM dans la chaîne.

### États terminaux
- [x] Non applicable : projection lecture-seule, sans cycle de vie
      propre ; les états UI restent ceux de `dashboardSessionMachine`.

## Corrections demandées (appliquées au modèle avant approbation)

1. **Portefeuille des statuts intermédiaires** : la première mouture
   consommait `execution_json.portfolio` pour tout statut porteur ; la
   revue a restreint la consommation à `CONFIRMED`,
   `PROTECTION_FAILED` et `NO_SELL_NEEDED`, en énumérant les statuts
   exclus (`REJECTED`, `TERMINAL_FAILED`, `UNKNOWN`) pour qu'aucun
   portefeuille pré-trade ne soit jamais pris pour un portefeuille
   post-trade.
2. **PnL réalisé du SELL sans position précédente connue** : remplacer
   la valeur `0` implicite par `null` (non mesurable dans la fenêtre),
   pour éviter de présenter un PnL nul traçable comme un fait.

## Vérifications d'implémentation (à faire au commit route/UI)

- V1 — La lecture PnL s'exécute dans le même `Promise.all` que
  `state`/`cycles` pendant `loading`/`refreshing`, sans nouvel état
  machine ni contexte supplémentaire.
- V2 — L'Agent borne les deux lectures SQL (`LIMIT` cycles, join ordres
  par `cycle_id`) et ne fait aucun appel réseau sortant sur cette route.
- V3 — Le parser du gateway revalide chaque champ (types, finitude,
  bornes) et plafonne la taille des tableaux reçus.
- V4 — Tests : agrégation correcte (équité, PnL, frais, slippage),
  pagination bornée, cas vide, échec fail-closed, badges de protection.

## Verdict

APPROUVÉ. La proposition est additive et strictement lecture-seule :
zéro transition, zéro écriture, projection pure traçable, frontière
proxy inchangée. Le principal risque (présenter une reconstruction
comme une mesure d'autorité) est couvert par P1, P3 et les corrections
1–2 ci-dessus.
