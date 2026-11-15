# Modèle du shell d'exécution Hyperliquid

Ce document borne la coquille impérative qui porte les effets réseau et de
signature de la machine `hyperliquidPerpOrderMachine`. Il n'introduit aucune
décision d'état : les transitions restent dans `models/hyperliquid-execution.md`.
Le shell est la seule frontière où vivent la clé d'agent, la signature
EIP-712 et les appels REST Hyperliquid.

## Secrets, flag et réglages

| Secret / variable | Rôle |
| --- | --- |
| `HYPERLIQUID_PERP_TRADING_ENABLED` | flag live perp dédié, `true` requis (séparé de `LIVE_TRADING_ENABLED` spot) |
| `HYPERLIQUID_AGENT_PRIVATE_KEY` | clé privée de l'API wallet (agent), format `0x` + 64 hex ; la clé principale du wallet ne quitte jamais le froid |
| `HYPERLIQUID_WALLET_ADDRESS` | adresse maître propriétaire des positions, `0x` + 40 hex |
| `HYPERLIQUID_TESTNET` | `true` pour viser le testnet (préflight et répétition) |
| `HYPERLIQUID_API_BASE_URL` | facultatif ; défaut `https://api.hyperliquid.xyz` (ou URL testnet) |

`resolveHyperliquidSettings` refuse tout réglage incomplet ou malformé avec
un code unique `HYPERLIQUID_EXECUTION_UNAVAILABLE` : aucun demi-réglage ne
peut signer. Les secrets restent des effets du shell et n'entrent jamais
dans le contexte de machine, l'état durable ou les logs.

## Effets et mapping vers les événements de la machine

| Effet du shell | Issue fermée | Événement machine |
| --- | --- | --- |
| construire l'action ordre (wire) puis signer EIP-712 | action signée, ou échec de signature | `ACTION_SIGNED` / `SIGN_FAILED` |
| `POST /exchange` (soumission, nonce = instant courant) | `ACCEPTED` / `REJECTED` / `UNKNOWN` | `SUBMIT_ACCEPTED` / `SUBMIT_REJECTED` / `SUBMIT_UNKNOWN` |
| `POST /info` `orderStatus` par `cloid` | résolu `ACCEPTED` / `REJECTED`, ou `UNKNOWN` | `RECONCILIATION_RESOLVED` / `RECONCILIATION_FAILED` |
| `POST /info` `meta` | méta validée (préflight) | hors machine : contrôle avant admission |

Règles de mapping de la soumission :

- HTTP 200 + `status: "ok"` sans erreur d'ordre → `ACCEPTED` (ordre posé ou
  exécuté) ;
- `status: "err"` ou erreur portée par l'ordre individuel → `REJECTED`,
  le détail textuel ne sert qu'à la télémétrie et ne pilote aucune
  transition ;
- erreur réseau, timeout, HTTP ≥ 400, corps non JSON, dépassement de taille
  ou réponse inattendue → `UNKNOWN` : la machine part en réconciliation,
  jamais en resoumission.

## Formatage d'un ordre marché IOC

1. la taille provient de la couche pure, déjà arrondie vers zéro à
   `szDecimals` ; le shell la rend en chaîne décimale exacte sans zéros
   traînants ;
2. le prix d'agression est `marque × (1 ± 50 bps)` (cap de glissement figé
   dans le shell, `MARKET_ORDER_SLIPPAGE_BPS`), arrondi à **5 chiffres
   significatifs** ;
3. type `{ limit: { tif: "Ioc" } }` — même ordre de grandeur que l'invariant
   spot : market IOC après clôture de bougie ;
4. `cloid` = `keccak256(clientOrderId)` tronqué à 16 octets (`0x` + 32 hex,
   format cloid Hyperliquid 128 bits) : mapping déterministe, idempotent,
   qui relie l'intention persistée à l'ordrevenue ;
5. `reduce_only: false`, `grouping: "na"` — la gestion de position reste
   l'affaire du cycle.

Les noms de marché dodash (`BTC-PERP`, `ETH-PERP`) sont traduits en noms
Hyperliquid (`BTC`, `ETH`) par une table figée ; l'indice d'actif vient de
la méta lue au moment de la soumission.

## Signature

Réplication fidèle du schéma du SDK de référence Hyperliquid v1.7.7
(`src/utils/signing.ts`) :

- hash d'action : encodage **msgpack** de l'action + nonce (8 octets
  big-endian) + octet de coffret (`0x00` sans vault) → `keccak256` ;
- domaine fantôme EIP-712 `{ name: "Exchange", version: "1", chainId: 1337 }`
  et type `Agent { source, connectionId }`, `source = "a"` en mainnet ;
- signature secp256k1 par la clé d'agent via ethers v6 ; sortie
  `{ r, s, v }`.

Le bundle Worker n'importe **pas** le SDK racine (qui tire des modules
`ws`) : seuls `@msgpack/msgpack` et `ethers`, tous deux purs, entrent dans
le bundle. Un test d'équivalence comparant notre signature à celle du SDK
garantit la fidélité du schéma à chaque montée de version.

## Préflight (contrôle avant admission)

`POST /info { type: "meta" }` fournit `universe: [{ name, szDecimals,
maxLeverage }]`. Avant toute admission live, le préflight vérifie pour
chaque marché de l'enveloppe figée :

1. le marché existe sous son nom Hyperliquid (`HYPERLIQUID_MARKET_MISSING`) ;
2. `szDecimals` est exactement celui de l'enveloppe
   (`HYPERLIQUID_SIZE_DECIMALS_MISMATCH`) ;
3. `maxLeverage` réel ≥ levier maximum de l'enveloppe
   (`HYPERLIQUID_LEVERAGE_CAP_UNAVAILABLE`).

Un préflight en échec bloque l'activation live perp tant qu'il n'est pas
repassé avec succès.

## Lectures de compte

`POST /info { type: "clearinghouseState", user }` fournit l'état réel du
compte : `assetPositions[].position.{coin, szi, unrealizedPnl}` et
`marginSummary.{accountValue, totalRawUsd}`. La lecture est convertie en
instantané typé fermé `HyperliquidAccountSnapshot` : positions
(quantité signée, PnL non réalisé), valeur de compte, exposition brute
totale telle que notée par la bourse (prix oracles).

`derivePerpRiskGate` dérive les entrées de garde d'une intention :

| Entrée | Dérivation |
| --- | --- |
| `positionQuantity` | `szi` du marché visé, `0` sans position |
| `otherGrossExposureNotional` | `max(0, totalRawUsd − \|position × prix de marque\|)` — approximation conservatrice qui mélange prix oracles et marque ; toute position hors allowlist du compte réduit la marge de manœuvre |
| `dailyPnl` | **jamais inférée** : le PnL journalier ancré sur un jour de référence reste un jalon séparé ; il est requis de la requête opérateur |

Une lecture indisponible, hors spec ou non numérique est une erreur fermée :
la route refuse avec `PERP_ACCOUNT_UNAVAILABLE` plutôt que de substituer des
zéros silencieux — une garde dérivée de zéros désactiverait le coupe-circuit
d'exposition.

## Limites de frontière

- réponses bornées (1 MiB) et timeout de 10 s, comme la frontière Coinbase ;
- aucun retry automatique de soumission : `UNKNOWN` mène à la
  réconciliation portée par la machine ;
- le détail textuel des erreurs API n'entre jamais dans un état durable ni
  dans un code de transition ; il n'alimente que la télémétrie.

## Invariants

1. La clé d'agent, la clé principale du wallet et toute signature n'entrent
   jamais dans le contexte de machine, l'état durable ou les logs.
2. Le nonce est l'heure courante en millisecondes, produit par le shell au
   moment de la signature.
3. Une soumission n'est jamais retentée automatiquement ; seule la machine
   décide de la réconciliation.
4. Le `cloid` est déterministe : le même `clientOrderId` persisté produit
   toujours le même identifiant d'ordrevenue.
5. Aucune taille n'est re-arrondie par le shell : la valeur reçue est déjà
   alignée sur `szDecimals` par la couche pure.
6. Le prix d'agression respecte le cap de glissement figé et les 5 chiffres
   significatifs d'Hyperliquid.
7. Les réglages incomplets invalident toute la chaîne live perp
   (`HYPERLIQUID_EXECUTION_UNAVAILABLE`), sans demi-activation.
8. Le flag `HYPERLIQUID_PERP_TRADING_ENABLED` est indépendant du flag spot ;
   l'un ne peut pas activer l'autre.
9. Toute réponse hors spec devient `UNKNOWN`, jamais une interprétation
   libre.
10. Le préflight doit repasser vert avant chaque activation live ; ses
    constats sont typés et fermés.
