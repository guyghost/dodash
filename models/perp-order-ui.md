# Modèle UI d'ordre perp

`perpOrderUiMachine` gouverne le formulaire d'intention perp du dashboard.
Machine d'interface, soeur de `baseWalletSessionMachine` : elle prépare et
confirme une intention, la soumet au proxy via le gateway, et affiche
l'issue. Elle ne décide d'aucun trading — `hyperliquidPerpOrderMachine`
reste l'unique arbitre côté Agent, et l'admission fermée plus ses gardes
sont réévaluées côté serveur.

## États, événements et effets

| État | Événement accepté | Effet autorisé | État suivant |
| --- | --- | --- | --- |
| `form` | `SUBMISSION_PREPARED` (brouillon valide, `canControl` + `canTrade`) | aucun | `confirming` |
| `form` | `SUBMISSION_PREPARED` (brouillon invalide ou permissions insuffisantes) | aucun | `form`, code fermé affiché |
| `confirming` | `PERP_ORDER_CONFIRMED` | générer le `clientOrderId` (fonction injectée), soumettre via le gateway | `submitting` |
| `confirming` | `PERP_ORDER_CANCELLED` | aucun | `form`, brouillon conservé |
| `submitting` | `SUBMISSION_SUCCEEDED` (issue fermée) | aucun | `result` |
| `submitting` | `SUBMISSION_FAILED` (erreur transport bornée) | aucun | `result` |
| `result` | `SUBMISSION_DISMISSED` | aucun | `form`, brouillon conservé |
| tout état | `PERP_ORDER_FORM_RESET` | purger brouillon et issue | `form` |

## Bornes du brouillon

Le brouillon est validé contre l'enveloppe figée avant `confirming` :
marché dans `HYPERLIQUID_PERP_POLICY.products`, `side` BUY/SELL, quantité
et prix de marque finis strictement positifs, levier entier dans
`[1, maxLeverage]`, `dailyPnl` fini requis (jamais inféré). Les champs de
garde dérivables du compte ne sont **pas** dans le formulaire : omis, ils
sont lus sur le compte réel par la route.

## Frontière d'effets

- Le `clientOrderId` est produit par le shell au moment de la confirmation
  (fonction injectée du dashboard) et validé par la garde de la machine —
  déterministe sous test, unique en production, format
  `^[a-zA-Z0-9-]{8,64}$`.
- Le gateway porte le Bearer dashboard vers le proxy ; la machine n'a
  aucune valeur d'identifiant, seulement `canControl`/`canTrade`.
- `submitting` n'est réceptif à rien d'autre que l'issue : un double clic
  ne peut pas produire deux soumissions.
- L'issue affichée est fermée : `SETTLED` (avec issue), `REFUSED` (code de
  la machine côté Agent), `FAILED` (code d'exécution), ou erreur transport
  `REQUEST_FAILED`. Aucun détail libre d'API n'est affiché.

## Invariants

1. Aucune soumission sans `canControl` **et** `canTrade`.
2. Aucun brouillon hors enveloppe n'atteint `confirming`.
3. Le `clientOrderId` n'existe pas avant la confirmation explicite.
4. Un formulaire ne soumet jamais deux fois : `submitting` est non
   réceptif.
5. Le brouillon survit à l'affichage d'une issue ; seul le reset le purge.
6. Aucune clé, aucun token, aucune valeur d'identifiant serveur n'entre
   dans le contexte.
7. Les codes affichés sont fermés et húmero la même nomenclature que les
   modèles serveur.
