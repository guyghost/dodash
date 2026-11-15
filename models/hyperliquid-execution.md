# Modèle d'exécution perp Hyperliquid

Venue retenue : **Hyperliquid**, routée par l'app Base (faits ancrés dans
`base-wallet-session.md`). Ce modèle fige l'enveloppe de risque confirmée
par l'opérateur le 28 août 2026, l'admission fermée qui la protège, la
garde de risque pure d'un ordre et la machine d'exécution d'un ordre.
Il ne remplace pas `tradingCycleMachine` : il est la patte d'ordre dédiée
que le shell devra orchestrer pour le marché perp.

## Enveloppe figée `HYPERLIQUID_PERP_2026_08`

- venue : `HYPERLIQUID` ;
- marchés : `BTC-PERP`, `ETH-PERP` ;
- levier maximum : **2x** (long et short), entier ;
- timeframe de décision : `ONE_DAY` ;
- ordre : 600 USD maximum ;
- position : 10 000 USD maximum ;
- exposition brute : 10 000 USD maximum ;
- perte journalière : 1 000 USD maximum (coupe-circuit).

Les incréments de taille (`szDecimals`) sont figés à 5 décimales pour
BTC-PERP et 4 pour ETH-PERP et **doivent être re-vérifiés lors du préflight
live** avant activation, comme l'exige l'invariant 11 de
`live-trading-policy.md` : une taille n'est jamais arrondie vers le haut
(`floorToSizeIncrement` arrondit vers zéro ; un résidu inférieur à un
incrément abandonne l'ordre).

## Admission

| Entrée | Décision |
| --- | --- |
| mode `paper` | hors de cette politique (`OUT_OF_SCOPE`) |
| marché hors allowlist | refus `PERP_PRODUCT_NOT_ALLOWED` |
| champ différent de l'enveloppe figée (venue, timeframe, levier, risque) | refus `PERP_POLICY_MISMATCH` |
| enveloppe exacte | admission `APPROVED` |

L'admission est évaluée par le shell avant l'événement
`ORDER_INTENT_REQUESTED` et re-vérifiée par la garde de la machine : un
double contrôle, jamais une confiance implicite.

## Garde de risque d'un ordre (`assessPerpOrderIntent`)

Évaluée avant tout effet, dans cet ordre :

| # | Garde | Refus |
| --- | --- | --- |
| 1 | champs valides (marché, side, quantité > 0, prix > 0, levier entier ≥ 1, PnL fini) | `PERP_INTENT_INVALID` |
| 2 | admission approuvée | `PERP_ADMISSION_REQUIRED` |
| 3 | `dailyPnl > -1 000` | `PERP_DAILY_LOSS_BREACHED` |
| 4 | `leverage ≤ 2` | `PERP_LEVERAGE_EXCEEDED` |
| 5 | `quantité × prix ≤ 600` | `PERP_ORDER_NOTIONAL_EXCEEDED` |
| 6 | `\|position résultante\| × prix ≤ 10 000` | `PERP_POSITION_EXCEEDED` |
| 7 | exposition brute hors produit + position résultante ≤ 10 000 | `PERP_EXPOSURE_EXCEEDED` |

Un refus est un résultat typé et fermé : aucune transition d'ordre, aucune
exception, aucun texte libre. La disponibilité de la clé d'agent est un
refus du même type (`AGENT_WALLET_NOT_READY`), porté par l'événement et
vérifié par la garde de la machine.

## Machine d'ordre

| État | Événement accepté | Effet autorisé | État suivant |
| --- | --- | --- | --- |
| `idle` | `ORDER_INTENT_REQUESTED` (signer prêt, garde exécutable) | persister l'intention (clientOrderId) | `persistingIntent` |
| `idle` | `ORDER_INTENT_REQUESTED` (refus) | aucun | `idle`, refus typé enregistré |
| `idle` | `ORDER_RECOVERY_REQUESTED` (reprise après crash) | réconcilier par `cloid` — jamais signer ni soumettre | `reconciling` |
| `idle` | `ORDER_RECOVERY_REQUESTED` (payload invalide) | aucun | `idle`, ignoré |
| `persistingIntent` | `INTENT_PERSIST_SUCCEEDED` | signer l'action EIP-712 | `signing` |
| `persistingIntent` | `INTENT_PERSIST_FAILED` | aucun | `failed` |
| `signing` | `ACTION_SIGNED` | soumettre via l'API Exchange Hyperliquid | `submitting` |
| `signing` | `SIGN_FAILED` | aucun | `failed` |
| `submitting` | `SUBMIT_ACCEPTED` | persister l'issue | `persistingOutcome` |
| `submitting` | `SUBMIT_REJECTED` | persister l'issue | `persistingOutcome` |
| `submitting` | `SUBMIT_UNKNOWN` | réconcilier via API Info | `reconciling` |
| `reconciling` | `RECONCILIATION_RESOLVED` | persister l'issue | `persistingOutcome` |
| `reconciling` | `RECONCILIATION_FAILED` | aucun | `failed` |
| `persistingOutcome` | `PERSIST_SUCCEEDED` | aucun | `settled` |
| `persistingOutcome` | `PERSIST_FAILED` | aucun | `failed` |
| `failed` / tout état | `RESET` | purger l'ordre local | `idle` |

`settled` conserve l'issue (`ACCEPTED` | `REJECTED`) pour la télémétrie ;
`failed` est stable et exige un `RESET` explicite de l'opérateur.

## Frontière d'effets

- **Clé d'agent (API wallet)** : le wallet principal approuve une clé d'agent
  dédiée ; seule cette clé vit dans les secrets Worker (`edge-security.md`).
  La clé principale du wallet n'entre jamais dans le bot. La machine ne
  conserve qu'un booléen `signerReady` porté par l'événement — jamais la
  clé, jamais une signature.
- **Signature** : l'action EIP-712 est signée hors chaîne par le shell ; le
  domaine de signature Hyperliquid n'implique pas la chaîne 8453 — la
  session wallet Base du dashboard reste un principal d'affichage et
  d'autorisation opérateur, pas une frontière de signature.
- **Soumission** : un appel REST à l'endpoint Exchange ; l'issue confirmée,
  rejetée ou inconnue est toujours convertie en événement typé fermé.
- **Réconciliation** : une issue inconnue déclenche une lecture
  (endpoint Info) par `clientOrderId`, jamais un retry de soumission.
- **Persistance** : l'intention (`clientOrderId`) est persistée avant tout
  appel réseau ; l'issue est persistée avant `settled`.

## Prérequis avant activation live

1. préflight vérifiant `szDecimals`, tailles minimales et tick réel du
   marché Hyperliquid ;
2. provision de la clé d'agent en secret Worker, hors `wrangler.jsonc` ;
3. flag live perp dédié côté shell (séparé du flag spot live) ;
4. vérification de l'éligibilité géographique de l'opérateur (pas d'accès
   US/UK/Canada à ce produit) ;
5. câblage du shell Worker (signing + REST) revu séparément — ce modèle est
   la couche pure ; `BASE_PERP_ADMISSION` reste fermée tant que ce câblage
   et ces prérequis ne sont pas vérifiés.

## Invariants

1. Aucun ordre ne quitte `idle` sans admission `APPROVED` et garde de risque
   exécutable, réévaluée par la garde de la machine.
2. `clientOrderId` est persisté avant toute signature ou appel réseau.
3. Aucune taille n'est arrondie vers le haut ; l'arrondi vers zéro précède
   l'événement et appartient au shell.
4. Une issue inconnue déclenche une réconciliation par `clientOrderId`,
   jamais un retry de soumission.
5. La clé d'agent, la clé du wallet et toute signature n'entrent jamais dans
   le contexte, l'état durable ou les logs ; seuls les temps de signature
   peuvent être signalés.
6. Le coupe-circuit journalier (`PERP_DAILY_LOSS_BREACHED`) précède toute
   évaluation de taille : une journée à −1 000 USD ne place plus d'ordre.
7. Le levier est un entier compris entre 1 et 2 ; aucune configuration ne
   peut dépasser l'enveloppe figée.
8. `failed` exige un `RESET` explicite ; `settled` est stable et n'est purgé
   que par `RESET`.
9. Un refus ou une erreur est un code fermé ; aucun texte libre de l'API ne
   pilote une transition.
10. Le mode paper reste hors de cette politique : l'exécution simulée
    existante n'est pas modifiée.
11. La reprise après crash (`ORDER_RECOVERY_REQUESTED`) n'entre que par
    `reconciling` : elle réévalue ni admission ni garde, ne signe et ne
    soumet jamais — une intention persistée sans issue est réconciliée par
    `cloid`, puis son issue est persistée avant `settled`.
