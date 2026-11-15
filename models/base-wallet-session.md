# Modèle de session wallet Base

Le dashboard ouvre une session wallet Base distincte de la session proxy :
`baseWalletSessionMachine` gouverne la connexion EIP-1193 au wallet Base
(réseau `eip155:8453`). La session wallet est un **principal** : elle établit
qui peut signer, elle ne décide d'aucune transition de trading. Le provider
EIP-1193 est un effet du shell navigateur ; la machine n'importe jamais le
provider et son contexte ne conserve qu'un booléen `providerPresent`.

## Venue retenue : Hyperliquid (routée par l'app Base)

La venue d'exécution est tranchée : les perpétuels de l'app Base sont
**Hyperliquid**. Coinbase route les ordres vers la liquidité et le matching
existants d'Hyperliquid ; l'app Base n'est que la couche de distribution.
Faits ancrés (Finance Magnates, 19 août 2026) : plus de 290 marchés (BTC,
ETH, actions tokenisées, matières premières), levier affiché jusqu'à 50x,
liquidation au-delà des seuils, accès refusé aux résidents US, UK et Canada.

Conséquences d'architecture :

1. Les positions vivent sur Hyperliquid L1 (HyperCore), pas sur la chaîne
   Base. La session wallet de cette machine reste le principal côté
   dashboard (adresse EVM), mais la contrainte de chaîne 8453 ne préjuge pas
   de la signature d'exécution : un ordre Hyperliquid est une action
   EIP-712 signée hors chaîne par la clé EVM — ce sera un effet du shell
   d'exécution dédié, jamais de cette machine.
2. L'automatisation passe par le pattern **API wallet** (agent wallet)
   d'Hyperliquid : le wallet principal approuve une clé d'agent dédiée que
   l'Agent détient en secret Worker ; la clé principale du wallet reste
   froide et n'entre jamais dans le bot. C'est le même partage de rôle que
   `edge-security.md` : la clé d'agent est un effet du shell.
3. L'issue d'un ordre Hyperliquid est confirmée/rejetée via la réponse REST
   et les flux temps réel, pas via un réceipt de transaction : le modèle de
   réconciliation reste du type confirmé / rejeté / inconnu → réconciliation,
   aligné sur les invariants du cycle de trading existant.

L'enveloppe de risque figée (`HYPERLIQUID_PERP_2026_08`) et la machine
d'exécution Hyperliquid sont désormais modélisées dans
`hyperliquid-execution.md`. L'admission reste fermée tant que les livrables
d'activation manquent :

- le câblage du shell Worker (clé d'agent en secret, signature EIP-712,
  REST Exchange/Info) avec sa revue ;
- le préflight live vérifiant `szDecimals`, tailles minimales et tick réels ;
- le flag live perp dédié côté shell ;
- la vérification d'éligibilité géographique de l'opérateur.

Aucun état de cette machine, même connecté sur Base, ne peut produire une
capacité de trading perp approuvée avant ces livrables. La fermeture est
testée comme invariant, pas comme commentaire.

## États, événements et effets

| État | Événement accepté | Effet autorisé | État suivant |
| --- | --- | --- | --- |
| `disconnected` | `CONNECT_REQUESTED` (provider présent) | shell : `eth_requestAccounts` + `eth_chainId` | `connecting` |
| `disconnected` | `CONNECT_REQUESTED` (provider absent) | aucun | `disconnected`, erreur `WALLET_PROVIDER_UNAVAILABLE` |
| `connecting` | `WALLET_CONNECTED` (adresse valide, chaîne 8453) | aucun | `connected` |
| `connecting` | `WALLET_CONNECTED` (adresse valide, autre chaîne) | aucun | `wrongChain` |
| `connecting` | `WALLET_CONNECTED` (adresse invalide) | aucun | `failed`, erreur `WALLET_INVALID_RESPONSE` |
| `connecting` | `CONNECTION_FAILED` | aucun | `failed` |
| `connected` | `WALLET_ACCOUNT_CHANGED` (adresse valide) | aucun | `connected`, rotation du compte |
| `connected` | `WALLET_ACCOUNT_CHANGED` (`null`) | aucun | `disconnected` |
| `connected` | `WALLET_ACCOUNT_CHANGED` (adresse invalide) | aucun | `failed`, erreur `WALLET_INVALID_RESPONSE` |
| `connected` | `WALLET_CHAIN_CHANGED` (8453) | aucun | `connected` |
| `connected` | `WALLET_CHAIN_CHANGED` (autre chaîne valide) | aucun | `wrongChain` |
| `wrongChain` | `WALLET_CHAIN_CHANGED` (8453) | aucun | `connected` |
| `wrongChain` | `WALLET_CHAIN_CHANGED` (autre chaîne valide) | aucun | `wrongChain` |
| `wrongChain` | `WALLET_ACCOUNT_CHANGED` (`null`) | aucun | `disconnected` |
| `wrongChain` | `WALLET_ACCOUNT_CHANGED` (adresse valide) | aucun | `wrongChain`, rotation du compte |
| `failed` | `CONNECT_REQUESTED` (provider présent) | relancer la connexion | `connecting` |
| tout état | `CONNECTION_FAILED` | aucun | `failed` |
| tout état | `DISCONNECT_REQUESTED` | shell : désabonner les événements wallet | `disconnected` |

`CONNECTION_FAILED` porte un code fermé : `WALLET_REQUEST_REJECTED` (refus
utilisateur, `retryable: true`) ou `WALLET_INVALID_RESPONSE` (payload ou
provider inattendu, `retryable: true`). Une adresse valide est
`0x` + 40 hexadécimaux en minuscules ; un `chainId` valide est un entier sûr
strictement positif. Le shell normalise l'adresse en minuscules **avant**
d'émettre `WALLET_CONNECTED` : la machine n'accepte que la forme canonique.

## Frontière d'effets

- Le shell navigateur détecte le provider injecté (`window.ethereum`), appelle
  `eth_requestAccounts` puis `eth_chainId`, et traduit les erreurs provider en
  codes fermés. Dans l'app Base, le provider injecté est celui du wallet ;
  sur navigateur desktop, l'extension Base/Coinbase Wallet fournit la même
  frontière EIP-1193.
- La machine ne voit ni le provider, ni la clé privée, ni une signature :
  seul le couple validé `(adresse, chainId)` entre dans le contexte.
- L'adresse affichée est tronquée côté UI ; le contexte conserve l'adresse
  complète en minuscules uniquement pour l'affichage et l'audit.
- L'absence de provider est une réponse typée, jamais une exception.
- Les souscriptions `accountsChanged`/`chainChanged` sont posées après une
  connexion réussie et retirées par le shell lors d'une déconnexion ; un
  événement reçu hors session est ignoré car les souscriptions sont déjà
  retirées.

## Admission perp (fermée)

`resolvePerpTradingCapability(account)` dérive la capacité depuis le contexte
de session et l'admission figée :

| Session | Admission | Capacité |
| --- | --- | --- |
| `account = null` | — | `LOCKED: WALLET_NOT_CONNECTED` |
| `chainId ≠ 8453` | — | `LOCKED: WRONG_CHAIN` |
| connecté sur Base | `CLOSED` | `LOCKED: ADMISSION_CLOSED` |
| connecté sur Base | `OPEN` avec venue nommée | `APPROVED` |

Le dernier cas est unreachable tant que l'enveloppe figée dit `CLOSED`. Toute
ouverture future exigera : le choix de la venue, l'enveloppe de risque figée
(notionnel, levier maximum, perte journalière), le modèle d'issue d'ordre
(confirmé / rejeté / inconnu → réconciliation) et une revue dédiée, dans le
même format que `live-trading-policy.md`.

## Invariants

1. Le wallet est un principal, pas un décideur : aucune transition de
   `tradingCycleMachine` ne dépend d'un événement wallet.
2. Aucune clé privée, signature ou référence de provider n'entre dans le
   contexte XState, l'URL, le stockage persistant ou les logs.
3. Le contexte ne conserve que des données validées : adresse canonique et
   `chainId` entier sûr ; tout payload invalide mène à `failed`.
4. Une session ne peut être `connected` que sur `eip155:8453` ; toute autre
   chaîne est un état `wrongChain` explicite, jamais une erreur silencieuse.
5. La révocation du wallet (`accountsChanged: []`) revient à
   `disconnected`.
6. `failed` est un état stable : seule une nouvelle `CONNECT_REQUESTED` ou une
   déconnexion en sort.
7. La capacité perp reste `LOCKED` tant que `BASE_PERP_ADMISSION` est fermée ;
   connecter un wallet n'ouvre aucune voie d'ordre.
8. Aucun état de cette machine ne soumet d'ordre : il n'existe aucun événement
   d'ordre ici ; la soumission future appartiendra à un modèle d'exécution
   dédié revué séparément.
9. Les erreurs provider sont des codes fermés ; aucun message libre de
   provider ne pilote une transition.
